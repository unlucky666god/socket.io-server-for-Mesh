import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { query } from "./db.js";
import jwt from "jsonwebtoken";
import 'dotenv/config';
import { createId } from '@paralleldrive/cuid2';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: process.env.ORIGIN_HOST || "*", // Адрес вашего фронтенда
    methods: ["GET", "POST"],
    allowedHeaders: ["my-custom-header"], // Можно добавить кастомные заголовки, если нужно
    credentials: true
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

io.use((socket, next) => {
  const token = socket.handshake.auth.token;

  if (!token) {
    return next(new Error("Auth error. Token can't find."));
  }

  socket.userId = token; 
  next();
});

io.on("connection", async (socket) => {
  const userId = socket.userId;

  socket.join(`${userId}`);

  try {
    await query(
      'UPDATE "users" SET status = $1 WHERE id = $2',
      ['online', userId]
    );
    console.log(`User ${userId} connected`);
  } catch (err) {
    console.error("Ошибка обновления статуса:", err);
  }

  socket.on('send_message', async ({ conversationId, text, mediaUrl, mediaType }) => { // Добавили поля
    try {
      const messageId = createId();

      const finalContent = text || "";

      // 1. Сохраняем в БД (убедись, что в таблице Message есть эти колонки)
      const res = await query(
        `INSERT INTO "Message" (
      id, 
      content, 
      "conversationId", 
      "senderId", 
      "createdAt", 
      "mediaUrl", 
      "mediaType"
    ) VALUES ($1, $2, $3, $4, NOW(), $5, $6) RETURNING *`,
        [messageId, text, conversationId, socket.userId, mediaUrl, mediaType] // Добавлены $5 и $6
      );

      const newMessage = res.rows[0];
      const participantsRes = await query(
        `SELECT "userId" FROM "Participant" WHERE "conversationId" = $1`,
        [conversationId]
      );

      // 2. Рассылаем всем участникам с учетом новых полей
      participantsRes.rows.forEach(participant => {
        io.to(participant.userId).emit('message:new', {
          id: newMessage.id,
          conversationId: newMessage.conversationId,
          senderId: newMessage.senderId,
          text: newMessage.content,
          mediaUrl: newMessage.mediaUrl,    // Передаем URL
          mediaType: newMessage.mediaType,  // Передаем Тип
          timestamp: new Date(newMessage.createdAt).toISOString(),
          status: newMessage.status
        });
      });

    } catch (err) {
      console.error(err);
      socket.emit('error', 'Message failed to save');
    }
  });

  // index.js (Server)
  socket.on('message:read', async ({ conversationId, messageIds }) => { // Принимаем массив
    try {
      const res = await query(
        `UPDATE "Message" SET status = $1 
       WHERE id = ANY($2) AND "senderId" != $3 
       RETURNING id`,
        ['READ', messageIds, socket.userId]
      );
      console.log(`Message status updated to read`, messageIds);

      if (res.rowCount > 0) {
        const updatedIds = res.rows.map(r => r.id);
        // Оповещаем участников, передавая массив обновленных ID
        const participantsRes = await query(
          `SELECT "userId" FROM "Participant" WHERE "conversationId" = $1`,
          [conversationId]);
        participantsRes.rows.forEach(participant => {
          io.to(participant.userId).emit('message:status_update', {
            messageIds: updatedIds,
            conversationId,
            status: 'read'
          });
        });
      }
    } catch (err) { console.error(err); }
  });

  // Server (index.js)
  socket.on('message:delete', async ({ conversationId, messageId }) => {
    try {
      console.log(`Запрос на удаление сообщения ${messageId} в беседе ${conversationId}`);

      // 1. Получаем список всех участников этой беседы из БД
      const participantsRes = await query(
        `SELECT "userId" FROM "Participant" WHERE "conversationId" = $1`,
        [conversationId]
      );

      const participants = participantsRes.rows;

      // 2. Рассылаем событие каждому участнику в его личную комнату
      participants.forEach(participant => {
        // Отправляем всем, включая отправителя (для синхронизации вкладок) 
        // или можно добавить проверку if (participant.userId !== socket.userId)
        io.to(participant.userId).emit('message:deleted', {
          messageId,
          conversationId
        });
      });

      console.log(`Событие удаления успешно разослано ${participants.length} участникам`);
    } catch (err) {
      console.error("Ошибка при рассылке удаления через сокеты:", err);
    }
  });

  socket.on('message:edit', async ({ conversationId, messageId, text }) => {
    try {
      const participantsRes = await query(
        `SELECT "userId" FROM "Participant" WHERE "conversationId" = $1`,
        [conversationId]
      );

      participantsRes.rows.forEach(participant => {
        io.to(participant.userId).emit('message:edited', {
          messageId,
          conversationId,
          text
        });
      });
    } catch (err) {
      console.error("Socket edit error:", err);
    }
  });
});



httpServer.listen(4000, () => {
  console.log("Server started on 4000 port");
});