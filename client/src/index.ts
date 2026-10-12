
import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import cors from "cors";
import { randomUUID } from "node:crypto";

const app = express();

app.use(cors({
  origin: "http://localhost:5174"
}));

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: "http://localhost:5174",
    methods: ["GET", "POST"]
  }
});

type Room = {
  hostId: string;
  participants: Set<string>;
};

const rooms = new Map<string, Room>();

io.on("connection", (socket) => {
  socket.on("room:join", (roomId: string, callback) => {
    if (
      typeof roomId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,50}$/.test(roomId)
    ) {
      callback({ error: "Código de sala inválido." });
      return;
    }

    let room = rooms.get(roomId);

    if (room && room.participants.size >= 5) {
      callback({ error: "Sala cheia." });
      return;
    }

    if (!room) {
      room = {
        hostId: socket.id,
        participants: new Set()
      };

      rooms.set(roomId, room);
    }

    room.participants.add(socket.id);
    socket.join(roomId);

    callback({
      roomId,
      hostId: room.hostId,
      selfId: socket.id,
      participants: [...room.participants]
    });

    socket.to(roomId).emit("room:user-joined", {
      userId: socket.id
    });
  });

  socket.on("signal", ({ roomId, to, data }) => {
    const room = rooms.get(roomId);

    if (
      !room ||
      !room.participants.has(socket.id) ||
      !room.participants.has(to)
    ) {
      return;
    }

    io.to(to).emit("signal", {
      from: socket.id,
      data
    });
  });

  socket.on("disconnect", () => {
    for (const [roomId, room] of rooms) {
      if (!room.participants.has(socket.id)) continue;

      room.participants.delete(socket.id);

      socket.to(roomId).emit("room:user-left", {
        userId: socket.id
      });

      if (room.hostId === socket.id) {
        // A versão inicial encerra a sala
        // quando o anfitrião desconecta.
        io.to(roomId).emit("room:closed");
        rooms.delete(roomId);
      } else if (room.participants.size === 0) {
        rooms.delete(roomId);
      }
    }
  });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/rooms/new", (_req, res) => {
  res.json({
    roomId: randomUUID().slice(0, 8)
  });
});

httpServer.listen(3001, () => {
  console.log("Servidor em http://localhost:3001");
});
