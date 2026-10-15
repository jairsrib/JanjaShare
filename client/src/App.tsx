
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { socket } from "./socket";
import "./App.css";

type Quality = 
  | "480p" 
  | "720p" 
  | "1080p";

type SignalData =
  | { type: "offer"; sdp: RTCSessionDescriptionInit }
  | { type: "answer"; sdp: RTCSessionDescriptionInit }
  | { type: "candidate"; candidate: RTCIceCandidateInit };

const rtcConfig: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" }
  ]
};

export default function App() {
  const [roomId, setRoomId] = useState("");
  const [inputRoom, setInputRoom] = useState("");
  const [joined, setJoined] = useState(false);
  const [hostId, setHostId] = useState("");
  const [selfId, setSelfId] = useState("");
  const [participants, setParticipants] = useState<string[]>([]);
  const [streams, setStreams] =
    useState<Record<string, MediaStream>>({});
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState("");
  const [quality, setQuality] = useState<Quality>("720p");
  const [watching, setWatching] = useState<Record<string, boolean>>({});


  const screenRef = useRef<MediaStream | null>(null);
  const peers = useRef(new Map<string, RTCPeerConnection>());
  const roomRef = useRef("");
  const hostRef = useRef("");
  const selfRef = useRef("");
  const sharingRef = useRef(false);
  const makingOffer = useRef<Map<string, boolean>>(new Map());
  const pendingCandidates =
    useRef(new Map<string, RTCIceCandidateInit[]>());

  function sendSignal(to: string, data: SignalData) {
    socket.emit("signal", {
      roomId: roomRef.current,
      to,
      data
    });
  }

  function closePeer(userId: string) {
    peers.current.get(userId)?.close();
    peers.current.delete(userId);
    pendingCandidates.current.delete(userId);

    setStreams((old) => {
      const next = { ...old };
      delete next[userId];
      return next;
    });

    setParticipants((old) =>
      old.filter((id) => id !== userId)
    );
  }

  function createPeer(userId: string) {
    const existing = peers.current.get(userId);
    if (existing) return existing;

    const pc = new RTCPeerConnection(rtcConfig);
    peers.current.set(userId, pc);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal(userId, {
          type: "candidate",
          candidate: event.candidate.toJSON()
        });
      }
    };

    
    pc.ontrack = (event) => {
      const stream = event.streams[0];

      if (!stream) {
        console.warn(
          "[WebRTC] Nenhum stream recebido de:",
          userId
        );
        return;
      }

      console.log(
        "[WebRTC] Stream recebido de:",
        userId,
        stream.getTracks().map((track) => ({
          kind: track.kind,
          readyState: track.readyState,
        }))
      );

      setStreams((old) => ({
        ...old,
        [userId]: stream,
      }));
    };


    pc.onconnectionstatechange = () => {
      if (
        pc.connectionState === "failed" ||
        pc.connectionState === "closed"
      ) {
        closePeer(userId);
      }
    };

    return pc;
  }

  async function flushCandidates(
    userId: string,
    pc: RTCPeerConnection
  ) {
    const candidates =
      pendingCandidates.current.get(userId) ?? [];

    pendingCandidates.current.delete(userId);

    for (const candidate of candidates) {
      await pc.addIceCandidate(candidate);
    }
  }

  async function offerTo(userId: string) {
    if (!screenRef.current) return;

    const pc = createPeer(userId);

    // Evita iniciar outra negociação simultaneamente.
    if (
      makingOffer.current.get(userId) ||
      pc.signalingState !== "stable"
    ) {
      return;
    }

    makingOffer.current.set(userId, true);

    try {
      const senders = pc.getSenders();

      for (const track of screenRef.current.getTracks()) {
        const alreadyAdded = senders.some(
          (sender) => sender.track?.id === track.id
        );

        if (!alreadyAdded) {
          pc.addTrack(track, screenRef.current);
        }
      }

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      sendSignal(userId, {
        type: "offer",
        sdp: pc.localDescription!,
      });
    } catch (err) {
      console.error("Erro ao criar oferta:", err);
    } finally {
      makingOffer.current.set(userId, false);
    }
  }

  async function handleSignal(
    from: string,
    data: SignalData
  ) {
    try {
      const pc = createPeer(from);

      if (data.type === "offer") {
        if (pc.signalingState !== "stable") {
          console.warn(
            "Oferta recebida durante outra negociação:",
            pc.signalingState
          );
          return;
        }

        await pc.setRemoteDescription(data.sdp);
        await flushCandidates(from, pc);

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        sendSignal(from, {
          type: "answer",
          sdp: pc.localDescription!,
        });
      } else if (data.type === "answer") {
        if (pc.signalingState !== "have-local-offer") {
          console.warn(
            "Resposta recebida fora de ordem:",
            pc.signalingState
          );
          return;
        }

        await pc.setRemoteDescription(data.sdp);
        await flushCandidates(from, pc);
      } else if (data.type === "candidate") {
        if (pc.remoteDescription) {
          await pc.addIceCandidate(data.candidate);
        } else {
          const list =
            pendingCandidates.current.get(from) ?? [];

          list.push(data.candidate);
          pendingCandidates.current.set(from, list);
        }
      }
    } catch (err) {
      console.error("Erro na conexão WebRTC:", err);
      setError("Não foi possível estabelecer a conexão.");
    }
  }

  useEffect(() => {
    function onSignal(message: {
      from: string;
      data: SignalData;
    }) {
      void handleSignal(message.from, message.data);
    }

    function onUserJoined(message: { userId: string }) {
      setParticipants((old) =>
        old.includes(message.userId)
          ? old
          : [...old, message.userId]
      );

      if (
        selfRef.current === hostRef.current &&
        sharingRef.current
      ) {
        void offerTo(message.userId);
      }
    }

    function onShareStopped() {
    setStreams({});
    }

    function onUserLeft(message: { userId: string }) {
      closePeer(message.userId);
    }

    function onRoomClosed() {
      leaveRoom();
      setError("O anfitrião encerrou a sala.");
    }

    socket.on("share:stopped", onShareStopped);
    socket.on("signal", onSignal);
    socket.on("room:user-joined", onUserJoined);
    socket.on("room:user-left", onUserLeft);
    socket.on("room:closed", onRoomClosed);

    return () => {
      socket.off("share:stopped", onShareStopped);
      socket.off("signal", onSignal);
      socket.off("room:user-joined", onUserJoined);
      socket.off("room:user-left", onUserLeft);
      socket.off("room:closed", onRoomClosed);
    };
  });

  
  async function captureScreen(quality: Quality) {
    const resolutions = {
      "480p": { width: 854, height: 480 },
      "720p": { width: 1280, height: 720 },
      "1080p": { width: 1920, height: 1080 },
    };

    const resolution = resolutions[quality];

    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });

    const videoTrack = stream.getVideoTracks()[0];

    try {
      await videoTrack.applyConstraints({
        width: { ideal: resolution.width },
        height: { ideal: resolution.height },
        frameRate: { ideal: 30, max: 30 },
      });
    } catch (err) {
      console.warn("Não foi possível aplicar todas as configurações:", err);
    }

    console.log("Qualidade selecionada:", quality);
    console.log("Configurações reais da captura:", videoTrack.getSettings());

    screenRef.current = stream;
    return stream;
  }


  async function toggleFullscreen(element: HTMLElement | null) {
    if (!element) return;

    if (document.fullscreenElement === element) {
      await document.exitFullscreen();
    } else {
      await element.requestFullscreen();
    }
  }

  async function joinRoom(id: string) {
    setError("");

    if (!socket.connected) {
      socket.connect();
    }

    if (!socket.connected) {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", () => resolve());
        socket.once("connect_error", () =>
          reject(new Error("Não foi possível conectar ao servidor."))
        );
      });
    }

    socket.emit("room:join", id, (result: {
      error?: string;
      roomId: string;
      hostId: string;
      selfId: string;
      participants: string[];
    }) => {
      if (result.error) {
        setError(result.error);
        return;
      }

      roomRef.current = result.roomId;
      hostRef.current = result.hostId;
      selfRef.current = result.selfId;

      setRoomId(result.roomId);
      setHostId(result.hostId);
      setSelfId(result.selfId);
      setParticipants(result.participants);
      setJoined(true);
    });
  }

  
  async function createRoom() {
    try {
      const serverUrl = import.meta.env.VITE_SERVER_URL.replace(/\/+$/, "");
      const response = await fetch(`${serverUrl}/api/rooms/new`);

      if (!response.ok) {
        throw new Error("Erro ao criar sala");
      }

      const data = await response.json();

      if (!data.roomId) {
        throw new Error("ID da sala não recebido");
      }

      await joinRoom(data.roomId);
    } catch (error) {
      console.error("Erro ao criar sala:", error);
      setError("Não foi possível criar a sala.");
    }
  }

  function submitJoin(event: FormEvent) {
    event.preventDefault();
    void joinRoom(inputRoom.trim());
  }

  
  async function startSharing() {
    try {
      const stream = await captureScreen(quality);

      console.log("Faixas de vídeo:", stream.getVideoTracks().length);
      console.log("Faixas de áudio:", stream.getAudioTracks().length);

      if (stream.getAudioTracks().length === 0) {
        console.warn(
          "Nenhuma faixa de áudio foi capturada. Confira as opções de compartilhamento."
        );
      }

      screenRef.current = stream;

      sharingRef.current = true;
      setSharing(true);

      stream.getVideoTracks()[0].onended = stopSharing;

      for (const userId of participants) {
        if (userId !== selfRef.current) {
          await offerTo(userId);
        }
      }
    } catch (err) {
      console.error(err);
      setError("Compartilhamento cancelado ou indisponível.");
    }
  }

  function stopSharing() {
    if (roomRef.current && selfRef.current === hostRef.current) {
      socket.emit("share:stopped", roomRef.current);
    }
    
    screenRef.current?.getTracks().forEach((track) => {
      track.stop();
    });

    screenRef.current = null;
    sharingRef.current = false;
    setSharing(false);

    peers.current.forEach((pc) => pc.close());
    peers.current.clear();
    pendingCandidates.current.clear();
    setStreams({});
  }

  function leaveRoom() {
    stopSharing();
    peers.current.forEach((pc) => pc.close());
    peers.current.clear();

    socket.disconnect();

    roomRef.current = "";
    hostRef.current = "";
    selfRef.current = "";

    setJoined(false);
    setParticipants([]);
    setStreams({});
    setRoomId("");
  }

  
  useEffect(() => {
    const room = new URLSearchParams(
      window.location.search
    ).get("room");

    if (room) {
      setInputRoom(room);
      void joinRoom(room);
    }
  },
  []);

const isHost = selfId === hostId;

  if (!joined) {
    return (
      <div className="app-shell home-shell">
        <header className="topbar">
          <div className="brand"><div className="brand__mark"><span /><span /></div><span className="brand__name">JanjaShare</span></div>
          <span className="home-tag">Compartilhamento em tempo real</span>
        </header>
        <main className="home-main">
          <section className="home-card">
            <div className="home-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg></div>
            <p className="eyebrow">SIMPLES. RÁPIDO. AO VIVO.</p>
            <h1>Compartilhe sua tela<br /><span>com quem importa.</span></h1>
            <p className="home-description">Crie uma sala e convide outras pessoas para assistir à sua tela em tempo real.</p>
            <button className="button button--primary home-create" onClick={() => void createRoom()}>＋ Criar nova sala</button>
            <div className="home-divider"><span />ou entre em uma sala<span /></div>
            <form className="join-form" onSubmit={submitJoin}>
              <input placeholder="Digite o código da sala" value={inputRoom} onChange={(e) => setInputRoom(e.target.value)} required />
              <button className="button button--secondary" type="submit">Entrar</button>
            </form>
            {error && <p className="error">{error}</p>}
            <p className="home-footnote">Até 5 participantes por sala · Sem instalação</p>
          </section>
        </main>
      </div>
    );
  }

  const remoteEntries = Object.entries(streams);
  const remoteEntry = remoteEntries[0];
  const remoteStream = remoteEntry?.[1];
  const remoteId = remoteEntry?.[0];
  const isSharingScreen = isHost && sharing && !!screenRef.current;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><div className="brand__mark"><span /><span /></div><span className="brand__name">JanjaShare</span></div>
        <div className="room-meta"><span className="room-meta__label">Sala</span><strong>{roomId}</strong></div>
        <div className="topbar__actions">
          <div className={`connection ${socket.connected ? "is-online" : "is-offline"}`}><span className="connection__dot" /><span>{socket.connected ? "Conectado" : "Desconectado"}</span></div>
          <button className="button button--ghost" onClick={() => void navigator.clipboard.writeText(`${window.location.origin}/?room=${roomId}`)} title="Copiar link">⌁ <span className="copy-label">Copiar link</span></button>
        </div>
      </header>

      <main className="main">
        <section className="workspace">
          <div className="toolbar">
            <label className={`quality-control ${sharing ? "is-disabled" : ""}`}>
              <span className="quality-control__label">Qualidade</span>
              <span className="quality-control__select"><select aria-label="Qualidade da transmissão" disabled={!isHost || sharing} value={quality} onChange={(e) => setQuality(e.target.value as Quality)}><option value="480p">480p</option><option value="720p">720p</option><option value="1080p">1080p</option></select><span className="select-chevron">⌄</span></span>
            </label>
            <div className="toolbar__actions">
              {isHost && <button className={`button ${sharing ? "button--secondary" : "button--primary"}`} onClick={() => sharing ? stopSharing() : void startSharing()}>{sharing ? "■ Parar compartilhamento" : "▣ Compartilhar tela"}</button>}
              <button className="button button--danger" onClick={leaveRoom}>↪ <span className="leave-label">Sair da sala</span></button>
            </div>
          </div>

          <div className="stage" ref={(el) => { if (el) { /* fullscreen target */ } }}>
            {isSharingScreen ? (
              <>
                <video autoPlay className="stage__video" muted playsInline ref={(el) => { if (el && screenRef.current && el.srcObject !== screenRef.current) el.srcObject = screenRef.current; }} />
                <div className="stage__status"><span className="live-dot" /> Sua tela</div>
                <button className="button button--ghost stage__fullscreen" aria-label="Tela cheia" title="Tela cheia" onClick={(e) => void toggleFullscreen(e.currentTarget.parentElement)}>⛶</button>
              </>
            ) : remoteStream && remoteId && !watching[remoteId] ? (
              <div className="empty-state transmission-state">
                <div className="empty-state__icon empty-state__icon--live"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg><span className="live-dot" /></div>
                <div><h1>Transmissão disponível</h1><p>Uma tela está pronta para ser exibida nesta sala.</p></div>
                <button className="button button--primary" onClick={() => setWatching((old) => ({ ...old, [remoteId]: true }))}>▶ Assistir transmissão</button>
                <small>O áudio e o vídeo começam após o seu clique</small>
              </div>
            ) : remoteStream && remoteId && watching[remoteId] ? (
              <>
                <video autoPlay className="stage__video" playsInline ref={(el) => { if (el) { if (el.srcObject !== remoteStream) el.srcObject = remoteStream; el.muted = false; void el.play().catch((err) => console.error("Erro ao iniciar vídeo remoto:", err)); } }} />
                <div className="stage__status"><span className="live-dot" /> Transmissão ao vivo</div>
                <button className="button button--ghost stage__fullscreen" aria-label="Tela cheia" title="Tela cheia" onClick={(e) => void toggleFullscreen(e.currentTarget.parentElement)}>⛶</button>
              </>
            ) : (
              <div className="empty-state">
                <div className="empty-state__icon"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg></div>
                <div><h1>Ninguém está compartilhando a tela</h1><p>Quando alguém iniciar uma transmissão, ela aparecerá aqui.</p></div>
                {isHost && <button className="button button--primary" onClick={() => void startSharing()}>▣ Compartilhar tela</button>}
              </div>
            )}
          </div>
          <footer className="stage-footer"><span>Protegido por conexão ponto a ponto</span><span className="stage-footer__quality">{quality} · 30 FPS</span></footer>
          {error && <p className="error">{error}</p>}
        </section>

        <aside className="participants-panel">
          <div className="participants-panel__header"><div><span className="eyebrow">NESTA SALA</span><h2>Participantes</h2></div><span className="participant-count">{participants.length}/5</span></div>
          <div className="participant-list">
            {participants.map((id) => {
              const participantIsHost = id === hostId;
              const participantIsSelf = id === selfId;
              const label = participantIsSelf ? "Você" : `Participante ${id.slice(0, 4)}`;
              return <div className="participant" key={id}><div className="avatar"><span>{participantIsSelf ? "V" : "P"}</span><i /></div><div className="participant__identity"><strong>{label}</strong><span>{participantIsSelf ? "Sua conexão" : "Na sala"}</span></div>{participantIsHost && <span className="host-badge">Anfitrião</span>}</div>;
            })}
            {participants.length === 0 && <p className="participant-empty">Nenhum participante conectado.</p>}
          </div>
          <div className="participants-panel__tip"><span className="tip-icon">ⓘ</span><p>Compartilhe o link para convidar pessoas. <strong>Até 5 participantes.</strong></p></div>
        </aside>
      </main>
    </div>
  );
}
