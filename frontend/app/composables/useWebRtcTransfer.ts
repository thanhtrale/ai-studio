import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  setDoc,
  updateDoc,
  type DocumentReference,
  type Firestore,
  type Unsubscribe,
} from 'firebase/firestore';

// Everything this app writes lives under the `ai-studio` collection so a single
// rules block can scope it away from the other apps sharing this project.
const ROOT = 'ai-studio';
const ROOM_PATH: [string, string, string] = [ROOT, 'p2p', 'rooms'];
const INBOX_DIR = 'ai-studio-inbox';

// 16 KiB is the chunk size every browser accepts on a data channel.
const CHUNK_SIZE = 16 * 1024;
const BUFFER_HIGH = 1024 * 1024;

// Credit window: the sender never runs more than this far ahead of the bytes the
// receiver has committed to disk. Without it a fast link fills the receiver's
// write queue in memory, which is the thing we are trying to avoid.
const ACK_WINDOW = 8 * 1024 * 1024;
const ACK_INTERVAL = 512 * 1024;

interface FileStart {
  type: 'file-start';
  id: string;
  name: string;
  size: number;
  mime: string;
}

interface FileEnd {
  type: 'file-end';
  id: string;
}

interface Ack {
  type: 'ack';
  bytes: number;
}

type Control = FileStart | FileEnd | Ack;

export interface ReceivedFile {
  id: string;
  name: string;
  size: number;
  mime: string;
  url: string;
  onDisk: boolean;
  entry: string | null;
}

export interface Progress {
  name: string;
  done: number;
  total: number;
}

export type Phase = 'idle' | 'hosting' | 'joining' | 'connected' | 'closed' | 'failed';

/** Where incoming bytes go: the origin private file system, or memory. */
interface Sink {
  onDisk: boolean;
  entry: string | null;
  write(chunk: ArrayBuffer): Promise<void>;
  close(mime: string): Promise<{ url: string; size: number }>;
}

async function openDiskSink(name: string): Promise<Sink | null> {
  try {
    if (!navigator.storage?.getDirectory) return null;
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(INBOX_DIR, { create: true });
    const handle = await dir.getFileHandle(name, { create: true });
    if (typeof handle.createWritable !== 'function') return null;
    const writable = await handle.createWritable();

    return {
      onDisk: true,
      entry: name,
      write: (chunk) => writable.write(chunk),
      close: async () => {
        await writable.close();
        // Backed by the file on disk, so handing it to the browser as an object
        // URL streams it instead of loading it.
        const file = await handle.getFile();
        return { url: URL.createObjectURL(file), size: file.size };
      },
    };
  } catch {
    return null;
  }
}

function openMemorySink(): Sink {
  const chunks: ArrayBuffer[] = [];
  return {
    onDisk: false,
    entry: null,
    write: async (chunk) => {
      chunks.push(chunk);
    },
    close: async (mime) => {
      const blob = new Blob(chunks, { type: mime || 'application/octet-stream' });
      chunks.length = 0;
      return { url: URL.createObjectURL(blob), size: blob.size };
    },
  };
}

function roomCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (n) => alphabet[n % alphabet.length]).join('');
}

export function useWebRtcTransfer() {
  const nuxt = useNuxtApp();
  const { turn } = useRuntimeConfig().public;

  const phase = ref<Phase>('idle');
  const roomId = ref('');
  const isHost = ref(false);
  const error = ref<string | null>(null);
  const events = ref<string[]>([]);
  const connectionState = ref<RTCPeerConnectionState | ''>('');
  const received = ref<ReceivedFile[]>([]);
  const sending = ref<Progress | null>(null);
  const receiving = ref<Progress | null>(null);
  const storingOnDisk = ref(false);

  let peer: RTCPeerConnection | null = null;
  let channel: RTCDataChannel | null = null;
  let roomRef: DocumentReference | null = null;
  let unsubscribes: Unsubscribe[] = [];

  let incoming: { meta: FileStart; sink: Sink; written: number; lastAck: number } | null = null;
  let writeQueue: Promise<void> = Promise.resolve();

  let ackedBytes = 0;
  let ackWaiter: (() => void) | null = null;

  function iceServers(): RTCIceServer[] {
    const servers: RTCIceServer[] = [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    ];
    const urls = turn.urls.split(',').map((url) => url.trim()).filter(Boolean);
    if (urls.length) servers.push({ urls, username: turn.username, credential: turn.credential });
    return servers;
  }

  function db(): Firestore {
    const instance = nuxt.$firestore as Firestore | undefined;
    if (!instance) throw new Error('Firebase chưa được cấu hình (thiếu NUXT_PUBLIC_FIREBASE_*)');
    return instance;
  }

  function note(line: string) {
    events.value = [`${new Date().toLocaleTimeString('vi-VN')} · ${line}`, ...events.value].slice(0, 60);
  }

  function fail(cause: unknown) {
    error.value = cause instanceof Error ? cause.message : String(cause);
    phase.value = 'failed';
    note(`lỗi: ${error.value}`);
  }

  function handleControl(control: Control) {
    if (control.type === 'ack') {
      ackedBytes = control.bytes;
      ackWaiter?.();
      ackWaiter = null;
      return;
    }

    if (control.type === 'file-start') {
      writeQueue = writeQueue.then(async () => {
        const name = `${control.id}-${control.name}`;
        const sink = (await openDiskSink(name)) ?? openMemorySink();
        storingOnDisk.value = sink.onDisk;
        incoming = { meta: control, sink, written: 0, lastAck: 0 };
        receiving.value = { name: control.name, done: 0, total: control.size };
        note(`đang nhận ${control.name} (${sink.onDisk ? 'ghi xuống đĩa' : 'giữ trong RAM'})`);
      });
      return;
    }

    writeQueue = writeQueue.then(async () => {
      if (!incoming) return;
      const { meta, sink } = incoming;
      const { url, size } = await sink.close(meta.mime);
      received.value = [
        { id: meta.id, name: meta.name, size, mime: meta.mime, url, onDisk: sink.onDisk, entry: sink.entry },
        ...received.value,
      ];
      note(`nhận xong ${meta.name}`);
      incoming = null;
      receiving.value = null;
    });
  }

  function handleChunk(chunk: ArrayBuffer) {
    writeQueue = writeQueue.then(async () => {
      if (!incoming) return;
      await incoming.sink.write(chunk);
      incoming.written += chunk.byteLength;
      receiving.value = { name: incoming.meta.name, done: incoming.written, total: incoming.meta.size };

      // Acknowledge only after the bytes are committed, so the sender's window
      // tracks disk progress rather than network arrival.
      if (incoming.written - incoming.lastAck >= ACK_INTERVAL || incoming.written >= incoming.meta.size) {
        incoming.lastAck = incoming.written;
        if (channel?.readyState === 'open') {
          channel.send(JSON.stringify({ type: 'ack', bytes: incoming.written } satisfies Ack));
        }
      }
    });
  }

  function attachChannel(dc: RTCDataChannel) {
    channel = dc;
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = BUFFER_HIGH / 2;
    dc.onopen = () => {
      phase.value = 'connected';
      note('data channel mở');
    };
    dc.onclose = () => {
      phase.value = 'closed';
      note('data channel đóng');
    };
    dc.onerror = () => note('data channel lỗi');
    dc.onmessage = (event) => {
      if (typeof event.data === 'string') handleControl(JSON.parse(event.data) as Control);
      else handleChunk(event.data as ArrayBuffer);
    };
  }

  function createPeer(): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: iceServers(), iceCandidatePoolSize: 10 });
    pc.onconnectionstatechange = () => {
      connectionState.value = pc.connectionState;
      note(`connection: ${pc.connectionState}`);
      if (pc.connectionState === 'failed') phase.value = 'failed';
    };
    pc.onicegatheringstatechange = () => note(`ice gathering: ${pc.iceGatheringState}`);
    return pc;
  }

  async function createRoom() {
    try {
      await hangUp();
      error.value = null;
      isHost.value = true;

      const pc = createPeer();
      peer = pc;
      attachChannel(pc.createDataChannel('file-transfer', { ordered: true }));

      const code = roomCode();
      roomId.value = code;
      roomRef = doc(db(), ...ROOM_PATH, code);
      const callerCandidates = collection(roomRef, 'callerCandidates');
      const calleeCandidates = collection(roomRef, 'calleeCandidates');

      pc.onicecandidate = (event) => {
        if (event.candidate) void addDoc(callerCandidates, event.candidate.toJSON());
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await setDoc(roomRef, { offer: { type: offer.type, sdp: offer.sdp }, createdAt: Date.now() });

      phase.value = 'hosting';
      note(`phòng ${code} đã tạo, chờ máy kia vào`);

      unsubscribes.push(
        onSnapshot(roomRef, (snapshot) => {
          const answer = snapshot.data()?.['answer'];
          if (answer && pc.signalingState === 'have-local-offer') {
            void pc.setRemoteDescription(new RTCSessionDescription(answer)).then(() => note('nhận answer'));
          }
        }),
        onSnapshot(calleeCandidates, (snapshot) => {
          for (const change of snapshot.docChanges()) {
            if (change.type === 'added') void pc.addIceCandidate(new RTCIceCandidate(change.doc.data()));
          }
        }),
      );
    } catch (cause) {
      fail(cause);
    }
  }

  async function joinRoom(code: string) {
    try {
      await hangUp();
      error.value = null;
      isHost.value = false;

      const normalized = code.trim().toUpperCase();
      roomRef = doc(db(), ...ROOM_PATH, normalized);
      const snapshot = await getDoc(roomRef);
      const offer = snapshot.data()?.['offer'];
      if (!offer) throw new Error(`Không tìm thấy phòng ${normalized}`);

      roomId.value = normalized;
      phase.value = 'joining';

      const pc = createPeer();
      peer = pc;
      pc.ondatachannel = (event) => attachChannel(event.channel);

      const callerCandidates = collection(roomRef, 'callerCandidates');
      const calleeCandidates = collection(roomRef, 'calleeCandidates');

      pc.onicecandidate = (event) => {
        if (event.candidate) void addDoc(calleeCandidates, event.candidate.toJSON());
      };

      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await updateDoc(roomRef, { answer: { type: answer.type, sdp: answer.sdp } });
      note(`đã gửi answer cho phòng ${normalized}`);

      unsubscribes.push(
        onSnapshot(callerCandidates, (snap) => {
          for (const change of snap.docChanges()) {
            if (change.type === 'added') void pc.addIceCandidate(new RTCIceCandidate(change.doc.data()));
          }
        }),
      );
    } catch (cause) {
      fail(cause);
    }
  }

  function waitForDrain(dc: RTCDataChannel) {
    return new Promise<void>((resolve) => {
      dc.addEventListener('bufferedamountlow', () => resolve(), { once: true });
    });
  }

  function waitForAck() {
    return new Promise<void>((resolve) => {
      ackWaiter = resolve;
    });
  }

  async function sendFile(file: File) {
    const dc = channel;
    if (!dc || dc.readyState !== 'open') {
      error.value = 'Chưa kết nối được với máy kia';
      return;
    }

    try {
      error.value = null;
      ackedBytes = 0;
      const id = crypto.randomUUID();
      dc.send(JSON.stringify({ type: 'file-start', id, name: file.name, size: file.size, mime: file.type }));
      sending.value = { name: file.name, done: 0, total: file.size };

      let offset = 0;
      while (offset < file.size) {
        if (dc.readyState !== 'open') throw new Error('Mất kết nối giữa chừng');
        if (dc.bufferedAmount > BUFFER_HIGH) await waitForDrain(dc);
        while (offset - ackedBytes > ACK_WINDOW) await waitForAck();

        // One slice at a time: the whole file is never resident in memory.
        const slice = file.slice(offset, offset + CHUNK_SIZE);
        dc.send(await slice.arrayBuffer());
        offset += slice.size;
        sending.value = { name: file.name, done: offset, total: file.size };
      }

      dc.send(JSON.stringify({ type: 'file-end', id }));
      note(`gửi xong ${file.name}`);
    } catch (cause) {
      fail(cause);
    } finally {
      sending.value = null;
      ackWaiter = null;
    }
  }

  async function discard(id: string) {
    const file = received.value.find((item) => item.id === id);
    if (!file) return;
    URL.revokeObjectURL(file.url);
    received.value = received.value.filter((item) => item.id !== id);
    if (!file.entry) return;
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(INBOX_DIR);
      await dir.removeEntry(file.entry);
    } catch {
      // Already gone, or the origin private file system is unavailable.
    }
  }

  async function hangUp() {
    for (const stop of unsubscribes) stop();
    unsubscribes = [];

    channel?.close();
    channel = null;
    peer?.close();
    peer = null;
    incoming = null;
    writeQueue = Promise.resolve();
    ackWaiter = null;
    ackedBytes = 0;
    sending.value = null;
    receiving.value = null;
    connectionState.value = '';

    // Only the host owns the room document; the candidate subcollections are left
    // behind because a browser client cannot delete a collection in one call.
    if (roomRef && isHost.value) await deleteDoc(roomRef).catch(() => undefined);
    roomRef = null;
    roomId.value = '';
    if (phase.value !== 'failed') phase.value = 'idle';
  }

  onBeforeUnmount(() => {
    void hangUp();
  });

  return {
    phase,
    roomId,
    isHost,
    error,
    events,
    connectionState,
    received,
    sending,
    receiving,
    storingOnDisk,
    createRoom,
    joinRoom,
    sendFile,
    discard,
    hangUp,
  };
}
