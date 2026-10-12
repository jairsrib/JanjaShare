import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import cors from "cors";
import { randomUUID } from "node:crypto";
const app = express();
const allowedOrigins = [
    "http://localhost:5173",
    "http://localhost:5174",
    "https://SEU-SITE.vercel.app",
];
app.use(cors({
    origin: allowedOrigins
}));
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: allowedOrigins,
        methods: ["GET", "POST"]
    }
});
const rooms = new Map();
io.on("connection", (socket) => {
    socket.on("room:join", (roomId, callback) => {
        if (typeof roomId !== "string" ||
            !/^[a-zA-Z0-9_-]{1,50}$/.test(roomId)) {
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
        if (!room ||
            !room.participants.has(socket.id) ||
            !room.participants.has(to)) {
            return;
        }
        io.to(to).emit("signal", {
            from: socket.id,
            data
        });
    });
    socket.on("share:stopped", (roomId) => {
        const room = rooms.get(roomId);
        if (room &&
            room.hostId === socket.id &&
            room.participants.has(socket.id)) {
            io.to(roomId).emit("share:stopped");
        }
    });
    socket.on("share:stopped", (roomId) => {
        const room = rooms.get(roomId);
        if (room &&
            room.hostId === socket.id &&
            room.participants.has(socket.id)) {
            io.to(roomId).emit("share:stopped");
        }
    });
    socket.on("disconnect", () => {
        for (const [roomId, room] of rooms) {
            if (!room.participants.has(socket.id))
                continue;
            room.participants.delete(socket.id);
            socket.to(roomId).emit("room:user-left", {
                userId: socket.id
            });
            if (room.hostId === socket.id) {
                io.to(roomId).emit("room:closed");
                rooms.delete(roomId);
            }
            else if (room.participants.size === 0) {
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
const PORT = process.env.PORT || 3001;
httpServer.listen(Number(PORT), "0.0.0.0", () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
//# sourceMappingURL=index.js.map