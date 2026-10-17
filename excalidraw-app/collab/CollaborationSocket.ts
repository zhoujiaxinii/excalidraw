import type {
  OnUserFollowedPayload,
  SocketId,
} from "@excalidraw/excalidraw/types";

/** The collaboration protocol, independent of a particular realtime SDK. */
export type CollaborationSocketEvents = {
  "init-room": [];
  "first-in-room": [];
  "new-user": [socketId: SocketId];
  "room-user-change": [clients: SocketId[]];
  "client-broadcast": [data: ArrayBuffer, iv: Uint8Array<ArrayBuffer>];
  "user-follow-room-change": [followers: SocketId[]];
  connect: [];
  reconnect: [];
  disconnect: [error: Error];
  connect_error: [error: Error];
  error: [error: Error];
};

export type CollaborationSocketEmits = {
  "join-room": [roomId: string | null];
  "server-broadcast": [
    roomId: string | null,
    data: ArrayBuffer,
    iv: Uint8Array<ArrayBuffer>,
  ];
  "server-volatile-broadcast": CollaborationSocketEmits["server-broadcast"];
  "user-follow": [payload: OnUserFollowedPayload];
};

export interface CollaborationSocket {
  readonly id: SocketId;
  readonly connected: boolean;
  connect(): void;
  on<K extends keyof CollaborationSocketEvents>(
    event: K,
    listener: (...args: CollaborationSocketEvents[K]) => void,
  ): this;
  once<K extends keyof CollaborationSocketEvents>(
    event: K,
    listener: (...args: CollaborationSocketEvents[K]) => void,
  ): this;
  off<K extends keyof CollaborationSocketEvents>(
    event: K,
    listener?: (...args: CollaborationSocketEvents[K]) => void,
  ): this;
  emit<K extends keyof CollaborationSocketEmits>(
    event: K,
    ...args: CollaborationSocketEmits[K]
  ): void;
  close(): void;
}
