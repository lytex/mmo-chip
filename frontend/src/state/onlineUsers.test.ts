import { describe, expect, it, beforeEach } from "vitest";
import { useOnlineUsers, type OnlineUser } from "./onlineUsers";

function reset() {
  useOnlineUsers.getState().setUsers([]);
}

const alice: OnlineUser = { userId: "a", username: "Alice", dieId: null, tool: null };
const bob: OnlineUser = { userId: "b", username: "Bob", dieId: "die1", tool: "schem" };

describe("onlineUsers store", () => {
  beforeEach(reset);

  it("setUsers deduplicates by userId", () => {
    // Server keys presence per socket; one user with two live connections
    // (stale half-open + reconnect) used to reach the panel twice —
    // producing non-unique React keys.
    useOnlineUsers
      .getState()
      .setUsers([alice, { ...alice, dieId: "die2", tool: "layout" }, bob]);
    expect(useOnlineUsers.getState().users).toHaveLength(2);
    expect(useOnlineUsers.getState().users.map((u) => u.userId)).toEqual(["a", "b"]);
  });

  it("addUser ignores a second entry for the same user", () => {
    useOnlineUsers.getState().addUser(alice);
    useOnlineUsers.getState().addUser({ ...alice, dieId: "die1" });
    expect(useOnlineUsers.getState().users).toHaveLength(1);
  });

  it("removeUser drops every entry of that user", () => {
    useOnlineUsers.getState().setUsers([alice, bob]);
    useOnlineUsers.getState().removeUser("a");
    expect(useOnlineUsers.getState().users.map((u) => u.userId)).toEqual(["b"]);
  });

  it("updateUser only touches the matching user", () => {
    useOnlineUsers.getState().setUsers([alice, bob]);
    useOnlineUsers.getState().updateUser("b", "die9", "trace");
    const users = useOnlineUsers.getState().users;
    expect(users).toHaveLength(2);
    expect(users[1]).toMatchObject({ userId: "b", dieId: "die9", tool: "trace" });
  });
});
