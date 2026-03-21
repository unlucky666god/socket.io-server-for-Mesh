import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import { query } from "./db.js";
import jwt from "jsonwebtoken";
import { error } from "console";
import 'dotenv/config';
import { createId } from '@paralleldrive/cuid2';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "http://localhost:3000", // Адрес вашего фронтенда
    methods: ["GET", "POST"],
    allowedHeaders: ["my-custom-header"], // Можно добавить кастомные заголовки, если нужно
    credentials: true
  }
});

io.use((socket, next) => {
  const token = socket.handshake.auth.token;

  if (!token) {
    return next(new Error("Auth error. Token can't find."));
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return next(new Error("Authentication error"));
    socket.userId = decoded.id;
    next();
  });
});

io.on("connection", async (socket) => {
  const userId = socket.userId;

  socket.join(`${userId}`);

  try {
    await query(
      'UPDATE "User" SET status = $1 WHERE id = $2',
      ['online', userId]
    );
  } catch (err) {
    console.error("Ошибка обновления статуса:", err);
  }

  socket.on('send_message', async ({ conversationId, text }) => {
    try {
      const messageId = createId();
      const res = await query(
        `INSERT INTO "Message" (id, content, "conversationId", "senderId", "createdAt") 
       VALUES ($1, $2, $3, $4, NOW()) 
       RETURNING *`,
        [messageId, text, conversationId, socket.userId]
      );

      const newMessage = res.rows[0];

      const participantsRes = await query(
        `SELECT "userId" FROM "Participant" WHERE "conversationId" = $1`,
        [conversationId]
      );

      const participants = participantsRes.rows; // Массив объектов [{userId: '...'}, ...]

      // 3. Рассылаем сообщение по персональным комнатам участников
      participants.forEach(participant => {
        // io.to() отправит сообщение всем сокетам (вкладкам) конкретного пользователя
        io.to(participant.userId).emit('message:new', {
          ...newMessage,
          // Можно добавить доп. поля, если фронтенд их ждет
          userId: newMessage.userId === userId ? 'me' : newMessage.userId
        });
      });

    } catch (err) {
      console.error(err);
      socket.emit('error', 'Message failed to save');
    }
  });

  socket.on("disconnect", async () => {
    console.log(`User ${userId} disconnected`);
    try {
      // Используйте то же имя таблицы, что и выше (users или "User")
      await query(
        'UPDATE "User" SET status = $1 WHERE id = $2',
        ['offline', userId]
      );
    } catch (err) {
      console.error("Ошибка при смене статуса на offline:", err);
    }
  });
});



httpServer.listen(4000, () => {
  console.log("Server started on 4000 port");
});