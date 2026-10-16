import { io, type Socket } from 'socket.io-client'

let socket: Socket | null = null

export function getSocket(): Socket {
  if (!socket) {
    socket = io({ path: '/socket.io', withCredentials: true, transports: ['websocket', 'polling'], autoConnect: true })
  }
  return socket
}

export function resetSocket() {
  socket?.disconnect()
  socket = null
}
