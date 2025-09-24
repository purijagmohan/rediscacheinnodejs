import * as net from "net";
import * as fs from "fs";
import * as path from "path";

// --- Redis-like typed value ---
type RedisType = "string";

interface RedisValue {
  type: RedisType;
  value: string;
  expireAt?: number; // timestamp in ms
  lastAccessed: number;
}

// --- RDB snapshot format ---
interface RDBData {
  timestamp: number; // snapshot creation time
  data: { [key: string]: RedisValue };
}

// --- MiniRedis store with LRU, TTL, AOF + RDB snapshot with delta replay ---
class MiniRedis {
  private store = new Map<string, RedisValue>();
  private maxEntries: number;
  private evictionCount = 0;
  private expiredCount = 0;

  private aofFile = path.resolve(__dirname, "appendonly.aof");
  private rdbFile = path.resolve(__dirname, "dump.rdb");
  private snapshotIntervalMs = 10000; // snapshot every 10s
  private cleanupIntervalMs = 5000;   // lazy expiration cleanup every 5s

  private lastSnapshotTime = 0;

  constructor(maxEntries = 5) {
    this.maxEntries = maxEntries;
    this.loadRDB();
    this.loadAOF(); // only replay delta
    this.startSnapshotLoop();
    this.startCleanupLoop();
  }

  // --- LRU Eviction ---
  private touch(key: string) {
    const entry = this.store.get(key);
    if (entry) entry.lastAccessed = Date.now();
  }

  private evictIfNeeded() {
    while (this.store.size >= this.maxEntries) {
      let lruKey: string | null = null;
      let oldest = Infinity;
      for (const [key, entry] of this.store.entries()) {
        if (entry.lastAccessed < oldest) {
          oldest = entry.lastAccessed;
          lruKey = key;
        }
      }
      if (lruKey) {
        this.store.delete(lruKey);
        this.evictionCount++;
        console.log(`[MiniRedis] LRU eviction: key='${lruKey}'`);
        this.appendToAOF(`DEL ${lruKey} ${Date.now()}`);
      }
    }
  }

  // --- Set / Get / DEL / EXPIRE / TTL ---
  set(key: string, value: string, expireAt?: number) {
    this.evictIfNeeded();
    this.store.set(key, { type: "string", value, expireAt, lastAccessed: Date.now() });
    const exPart = expireAt ? " EX " + Math.floor((expireAt - Date.now()) / 1000) : "";
    this.appendToAOF(`SET ${key} ${value}${exPart} ${Date.now()}`);
    return "OK";
  }

  get(key: string): string | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expireAt && Date.now() > entry.expireAt) {
      this.store.delete(key);
      this.expiredCount++;
      return null;
    }
    this.touch(key);
    return entry.value;
  }

  del(keys: string[]): number {
    let count = 0;
    for (const k of keys) {
      if (this.store.delete(k)) {
        count++;
        this.appendToAOF(`DEL ${k} ${Date.now()}`);
      }
    }
    return count;
  }

  expire(key: string, seconds: number): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;
    entry.expireAt = Date.now() + seconds * 1000;
    this.appendToAOF(`EXPIRE ${key} ${seconds} ${Date.now()}`);
    return true;
  }

  ttl(key: string): number {
    const entry = this.store.get(key);
    if (!entry) return -2;
    if (!entry.expireAt) return -1;
    const remaining = Math.floor((entry.expireAt - Date.now()) / 1000);
    if (remaining <= 0) {
      this.store.delete(key);
      this.expiredCount++;
      return -2;
    }
    return remaining;
  }

  getEvictionCount() { return this.evictionCount; }
  getExpiredCount() { return this.expiredCount; }
  getKeyCount() { return this.store.size; }
  getMaxEntries() { return this.maxEntries; }

  // --- AOF Persistence ---
  private appendToAOF(command: string) {
    fs.appendFileSync(this.aofFile, command + "\n", { encoding: "utf-8" });
  }

  private loadAOF() {
    if (!fs.existsSync(this.aofFile)) return;
    const lines = fs.readFileSync(this.aofFile, "utf-8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      const ts = this.getTimestampFromAOF(line);
      if (ts > this.lastSnapshotTime) this.executeRawCommand(line.trim());
    }
    console.log(`[MiniRedis] AOF loaded delta: ${this.store.size} keys`);
  }

  private getTimestampFromAOF(line: string): number {
    const parts = line.split(" ");
    const lastPart = parts[parts.length - 1];
    const ts = parseInt(lastPart);
    return isNaN(ts) ? 0 : ts;
  }

  // --- RDB Snapshotting ---
  private startSnapshotLoop() {
    setInterval(() => {
      this.saveRDB();
    }, this.snapshotIntervalMs);
  }

  private saveRDB() {
    const data: RDBData = {
      timestamp: Date.now(),
      data: Object.fromEntries(this.store),
    };
    fs.writeFileSync(this.rdbFile, JSON.stringify(data), { encoding: "utf-8" });
    this.lastSnapshotTime = data.timestamp;
    console.log(`[MiniRedis] RDB snapshot saved: ${Object.keys(data.data).length} keys`);
  }

  private loadRDB() {
    if (!fs.existsSync(this.rdbFile)) return;
    try {
      const snapshot: RDBData = JSON.parse(fs.readFileSync(this.rdbFile, "utf-8"));
      this.store = new Map(Object.entries(snapshot.data));
      this.lastSnapshotTime = snapshot.timestamp;
      console.log(`[MiniRedis] RDB loaded: ${this.store.size} keys (snapshot time: ${this.lastSnapshotTime})`);
    } catch (err) {
      console.error("[MiniRedis] Failed to load RDB:", err);
    }
  }

  // --- Lazy expiration cleanup loop ---
  private startCleanupLoop() {
    setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.store.entries()) {
        if (entry.expireAt && entry.expireAt <= now) {
          this.store.delete(key);
          this.expiredCount++;
          this.appendToAOF(`DEL ${key} ${Date.now()}`);
          console.log(`[MiniRedis] Lazy expiration cleanup: key='${key}'`);
        }
      }
    }, this.cleanupIntervalMs);
  }

  // --- Execute raw command from AOF ---
  private executeRawCommand(line: string) {
    const parts = line.split(" ");
    const cmd = parts[0].toUpperCase();
    switch (cmd) {
      case "SET": {
        const key = parts[1];
        const value = parts[2];
        let expireAt: number | undefined;
        if (parts[3]?.toUpperCase() === "EX" && parts[4]) expireAt = Date.now() + parseInt(parts[4]) * 1000;
        this.store.set(key, { type: "string", value, expireAt, lastAccessed: Date.now() });
        break;
      }
      case "DEL": this.store.delete(parts[1]); break;
      case "EXPIRE": {
        const key = parts[1];
        const seconds = parseInt(parts[2]);
        const entry = this.store.get(key);
        if (entry) entry.expireAt = Date.now() + seconds * 1000;
        break;
      }
    }
  }
}

// --- RESP encoders & parser ---
function encodeSimpleString(s: string) { return `+${s}\r\n`; }
function encodeError(msg: string) { return `-ERR ${msg}\r\n`; }
function encodeInteger(n: number) { return `:${n}\r\n`; }
function encodeBulkString(s: string | null) { return s === null ? `$-1\r\n` : `$${s.length}\r\n${s}\r\n`; }

function parseRESPBuffer(buffer: Buffer): string[] | null {
  let offset = 0;
  function readLine(): string {
    const end = buffer.indexOf("\r\n", offset);
    if (end === -1) return "";
    const line = buffer.slice(offset, end).toString();
    offset = end + 2;
    return line;
  }
  if (buffer[offset] !== 42) return null;
  const count = parseInt(readLine().slice(1));
  const result: string[] = [];
  for (let i = 0; i < count; i++) {
    if (buffer[offset] !== 36) return null;
    const len = parseInt(readLine().slice(1));
    const val = buffer.slice(offset, offset + len).toString();
    result.push(val);
    offset += len;
    if (buffer[offset] === 13 && buffer[offset + 1] === 10) offset += 2;
  }
  return result;
}

// --- Server ---
const redis = new MiniRedis(5);

const server = net.createServer((socket) => {
  socket.on("data", (data: Buffer) => {
    const commands = parseRESPBuffer(data);
    if (!commands || commands.length === 0) { socket.write(encodeError("invalid command")); return; }

    const [command, ...args] = commands;
    let response: string;

    switch (command.toUpperCase()) {
      case "PING": response = encodeSimpleString("PONG"); break;

      case "SET": {
        if (args.length < 2) { response = encodeError("wrong number of arguments for 'SET'"); break; }
        let key = args[0], value = args[1], expireAt: number | undefined;
        for (let i = 2; i < args.length; i++) {
          const opt = args[i].toUpperCase();
          if (opt === "EX" && args[i + 1]) { expireAt = Date.now() + parseInt(args[i + 1]) * 1000; i++; }
          else if (opt === "PX" && args[i + 1]) { expireAt = Date.now() + parseInt(args[i + 1]); i++; }
        }
        response = encodeSimpleString(redis.set(key, value, expireAt));
        break;
      }

      case "GET": response = args.length !== 1 ? encodeError("wrong number of arguments for 'GET'") : encodeBulkString(redis.get(args[0])); break;

      case "DEL": response = args.length < 1 ? encodeError("wrong number of arguments for 'DEL'") : encodeInteger(redis.del(args)); break;

      case "EXPIRE": response = args.length !== 2 ? encodeError("wrong number of arguments for 'EXPIRE'") : encodeInteger(redis.expire(args[0], parseInt(args[1])) ? 1 : 0); break;

      case "TTL": response = args.length !== 1 ? encodeError("wrong number of arguments for 'TTL'") : encodeInteger(redis.ttl(args[0])); break;

      case "INFO":
        if (args.length === 1 && args[0].toUpperCase() === "MEMORY") {
          response = encodeBulkString(
            `# Memory\r\nmaxmemory:${redis.getMaxEntries()}\r\nused_memory:${redis.getKeyCount()}\r\nevictions:${redis.getEvictionCount()}\r\nmemory_policy:allkeys-lru`
          );
        } else {
          response = encodeBulkString(
            `# Server\r\nmini_redis_version:0.2\r\n# Stats\r\nevicted_keys:${redis.getEvictionCount()}\r\nexpired_keys:${redis.getExpiredCount()}\r\nkey_count:${redis.getKeyCount()}\r\nmax_entries:${redis.getMaxEntries()}`
          );
        }
        break;

      case "QUIT": response = encodeSimpleString("Goodbye"); socket.write(response); socket.end(); return;

      default: response = encodeError(`unknown command '${command}'`);
    }

    socket.write(response);
  });
});

server.listen(6379, () => console.log("MiniRedis running on port 6379"));
