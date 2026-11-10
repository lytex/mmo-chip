import { create } from "zustand";

export interface OnlineUser {
  userId: string;
  username: string;
  dieId: string | null;
  tool: string | null;
}

interface OnlineUsersState {
  users: OnlineUser[];
  setUsers: (users: OnlineUser[]) => void;
  addUser: (user: OnlineUser) => void;
  removeUser: (userId: string) => void;
  updateUser: (userId: string, dieId: string | null, tool: string | null) => void;
}

export const useOnlineUsers = create<OnlineUsersState>()((set, get) => ({
  users: [],

  setUsers(users) {
    // Dedupe by userId: the server keys presence per WebSocket connection,
    // and one user can hold two sockets (a stale half-open connection plus
    // its reconnect). A duplicated list used to reach the render layer as
    // non-unique React keys (`OnlineUsersPanel`), spamming console warnings
    // on every re-render.
    const seen = new Set<string>();
    const unique = users.filter((u) => {
      if (seen.has(u.userId)) return false;
      seen.add(u.userId);
      return true;
    });
    set({ users: unique });
  },

  addUser(user) {
    const existing = get().users.find((u) => u.userId === user.userId);
    if (existing) return; // already known
    set({ users: [...get().users, user] });
  },

  removeUser(userId) {
    set({ users: get().users.filter((u) => u.userId !== userId) });
  },

  updateUser(userId, dieId, tool) {
    set({
      users: get().users.map((u) =>
        u.userId === userId ? { ...u, dieId, tool } : u
      )
    });
  }
}));
