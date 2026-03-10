import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { Server } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import Redis from 'ioredis';

const dev = process.env.NODE_ENV !== 'production';
const hostname = '0.0.0.0';
const port = parseInt(process.env.PORT || '3000', 10);
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;

interface User {
  id: string;
  socketId: string;
  username: string;
  country: string;
  gender: string;
  mode: 'text' | 'video' | 'voice';
  status: 'IDLE' | 'WAITING' | 'MATCHED';
  roomId?: string;
}

app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url!, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error('Error occurred handling', req.url, err);
      res.statusCode = 500;
      res.end('internal server error');
    }
  });

  const io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    },
    pingTimeout: 60000,
    pingInterval: 25000
  });

  io.on('connection', (socket) => {
    console.log(`[DEBUG] Socket connected: ${socket.id}`);

    socket.on('join_queue', async (data: { userId: string; username: string; country: string; gender: string; mode: 'text' | 'video' | 'voice' }) => {
      const { userId, username, country, gender, mode } = data;
      console.log(`[DEBUG] join_queue received from ${userId} (${username}) for mode ${mode}`);
      
      if (!redis) {
        console.error('Redis not initialized');
        return;
      }

      // Remove any existing entry for this userId to handle reconnections
      const oldSocketId = await redis.get(`userIdToSocketId:${userId}`);
      if (oldSocketId) {
        await redis.del(`user:${oldSocketId}`);
        await redis.del(`userIdToSocketId:${userId}`);
        // Also remove from all queues
        for (const m of ['text', 'video', 'voice']) {
          await redis.lrem(`queue:${m}`, 0, oldSocketId);
        }
      }

      const newUser: User = {
        id: userId,
        socketId: socket.id,
        username,
        country,
        gender,
        mode,
        status: 'WAITING',
      };

      await redis.hmset(`user:${socket.id}`, newUser as any);
      await redis.set(`userIdToSocketId:${userId}`, socket.id);
      await redis.rpush(`queue:${mode}`, socket.id);
      
      console.log(`[DEBUG] User added: ${userId} (${username}) for mode: ${mode}. Socket: ${socket.id}`);
      console.log(`[DEBUG] Queue ${mode} length: ${await redis.llen(`queue:${mode}`)}`);

      // Instant Matchmaking Logic
      let matched = false;
      
      while ((await redis.llen(`queue:${mode}`)) >= 2) {
        const partnerSocketId = await redis.lpop(`queue:${mode}`);
        if (!partnerSocketId || partnerSocketId === socket.id) {
          if (partnerSocketId === socket.id) await redis.rpush(`queue:${mode}`, partnerSocketId);
          continue;
        }
        
        const partnerSocket = io.sockets.sockets.get(partnerSocketId);
        
        if (partnerSocket && partnerSocket.connected) {
          console.log(`[DEBUG] Partner ${partnerSocketId} is connected. Finalizing match.`);
          const roomId = uuidv4();
          
          // Update statuses
          await redis.hmset(`user:${socket.id}`, { status: 'MATCHED', roomId } as any);
          await redis.hmset(`user:${partnerSocketId}`, { status: 'MATCHED', roomId } as any);

          console.log(`[DEBUG] Match created: ${socket.id} <-> ${partnerSocketId} in room: ${roomId}`);

          // Join rooms
          socket.join(roomId);
          partnerSocket.join(roomId);
          
          // Emit match_found to both
          const partnerData = await redis.hgetall(`user:${partnerSocketId}`);
          socket.emit('match_found', {
            roomId,
            partnerId: partnerData.id,
            partnerName: partnerData.username,
            partnerCountry: partnerData.country,
            partnerGender: partnerData.gender,
            isInitiator: true
          });

          const userData = await redis.hgetall(`user:${socket.id}`);
          partnerSocket.emit('match_found', {
            roomId,
            partnerId: userData.id,
            partnerName: username,
            partnerCountry: country,
            partnerGender: gender,
            isInitiator: false
          });

          matched = true;
          break;
        } else {
          console.log(`[DEBUG] Skipping disconnected partner ${partnerSocketId} in queue ${mode}`);
        }
      }
    });

    socket.on('leave_queue', async () => {
      if (!redis) return;
      const user = await redis.hgetall(`user:${socket.id}`);
      if (user.id) {
        await redis.del(`user:${socket.id}`);
        await redis.del(`userIdToSocketId:${user.id}`);
        await redis.lrem(`queue:${user.mode}`, 0, socket.id);
        console.log(`[DEBUG] User removed from queue: ${user.id}`);
      }
    });

    socket.on('send_message', async (data: { roomId: string; text: string; imageUrl?: string }) => {
      if (!redis) return;
      const user = await redis.hgetall(`user:${socket.id}`);
      socket.to(data.roomId).emit('receive_message', {
        from: user.id,
        text: data.text,
        imageUrl: data.imageUrl
      });
    });

    socket.on('typing', (data: { roomId: string; isTyping: boolean }) => {
      socket.to(data.roomId).emit('partner_typing', { isTyping: data.isTyping });
    });

    socket.on('webrtc_signal', (data: { roomId: string; signal: any }) => {
      socket.to(data.roomId).emit('webrtc_signal', { signal: data.signal });
    });

    socket.on('disconnect', async () => {
      if (!redis) return;
      const user = await redis.hgetall(`user:${socket.id}`);
      if (user.id) {
        await redis.lrem(`queue:${user.mode}`, 0, socket.id);
        if (user.roomId) {
          socket.to(user.roomId).emit('partner_left');
          console.log(`[DEBUG] Match cancelled: User ${user.id} disconnected from room ${user.roomId}`);
        }
        await redis.del(`user:${socket.id}`);
        await redis.del(`userIdToSocketId:${user.id}`);
        console.log(`[DEBUG] User removed from queue/active: ${user.id}`);
      }
      console.log(`[DEBUG] Socket disconnected: ${socket.id}`);
    });
  });

  server.listen(port, () => {
    console.log(`> Ready on http://${hostname}:${port}`);
  });
});
