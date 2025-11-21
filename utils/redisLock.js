// import { createClient } from "redis";

// const REDIS_URL = process.env.REDIS_URL;
// const ENABLE_REDIS = process.env.USE_REDIS === "true" && !!REDIS_URL;
// let client = null;

// // In-memory fallback when Redis is not available (useful for local dev/tests)
// const memAttempts = new Map(); // email -> { attempts, expiresAt }
// const memLocks = new Map(); // email -> expiresAt

// function _cleanupMem(email) {
//   const now = Date.now();
//   const a = memAttempts.get(email);
//   if (a && a.expiresAt <= now) memAttempts.delete(email);
//   const l = memLocks.get(email);
//   if (l && l <= now) memLocks.delete(email);
// }

// function attemptsKey(email) {
//   return `login:attempts:${encodeURIComponent(email)}`;
// }
// function lockKey(email) {
//   return `login:lock:${encodeURIComponent(email)}`;
// }

// async function getClient() {
//   if (!ENABLE_REDIS) return null;
//   if (client && client.isOpen) return client;
//   if (!client) {
//     client = createClient({ url: REDIS_URL });
//     client.on("error", (err) => console.warn("Redis Client Error", err && err.message ? err.message : err));
//   }
//   try {
//     if (!client.isOpen) await client.connect();
//     return client;
//   } catch (err) {
//     // If Redis isn't reachable, return null to signal fail-open behavior
//     console.warn("Redis connect failed:", err && err.message ? err.message : err);
//     return null;
//   }
// }

// // Returns seconds remaining if locked, or 0 if not locked
// async function isLocked(email) {
//   try {
//     const c = await getClient();
//     if (!c) {
//       // use in-memory fallback
//       _cleanupMem(email);
//       const expiresAt = memLocks.get(email) || 0;
//       if (expiresAt && expiresAt > Date.now()) {
//         return Math.ceil((expiresAt - Date.now()) / 1000);
//       }
//       return 0;
//     }
//     const ttl = await c.ttl(lockKey(email));
//     return ttl > 0 ? ttl : 0;
//   } catch (err) {
//     console.warn("isLocked error:", err && err.message ? err.message : err);
//     return 0;
//   }
// }

// // Increment attempts. If threshold reached, set lock for lockSeconds.
// // Returns: { attempts, locked, ttl }
// async function incrementAttempts(email, threshold = 5, lockSeconds = 30) {
//   try {
//     const c = await getClient();
//     if (!c) {
//       // in-memory fallback
//       _cleanupMem(email);
//       const now = Date.now();
//       const entry = memAttempts.get(email) || { attempts: 0, expiresAt: now + lockSeconds * 1000 };
//       entry.attempts = (entry.attempts || 0) + 1;
//       entry.expiresAt = now + lockSeconds * 1000;
//       memAttempts.set(email, entry);
//       if (entry.attempts >= threshold) {
//         const lockUntil = now + lockSeconds * 1000;
//         memLocks.set(email, lockUntil);
//         memAttempts.delete(email);
//         return { attempts: entry.attempts, locked: true, ttl: lockSeconds };
//       }
//       const ttl = Math.ceil((entry.expiresAt - now) / 1000);
//       return { attempts: entry.attempts, locked: false, ttl };
//     }
//     const aKey = attemptsKey(email);
//     const lKey = lockKey(email);

//     const attempts = await c.incr(aKey);
//     // set expiry on attempts key so it doesn't live forever
//     if ((await c.ttl(aKey)) === -1) await c.expire(aKey, lockSeconds);

//     if (attempts >= threshold) {
//       await c.set(lKey, "1", { EX: lockSeconds });
//       await c.del(aKey);
//       return { attempts, locked: true, ttl: lockSeconds };
//     }

//     const ttl = await c.ttl(aKey);
//     return { attempts, locked: false, ttl };
//   } catch (err) {
//     console.warn("incrementAttempts error:", err && err.message ? err.message : err);
//     return { attempts: 0, locked: false, ttl: 0 };
//   }
// }

// async function resetAttempts(email) {
//   try {
//     const c = await getClient();
//     if (!c) {
//       memAttempts.delete(email);
//       memLocks.delete(email);
//       return;
//     }
//     await c.del(attemptsKey(email));
//     await c.del(lockKey(email));
//   } catch (err) {
//     console.warn("resetAttempts error:", err && err.message ? err.message : err);
//   }
// }

// // Optional explicit initializer
// async function initRedis() {
//   await getClient();
// }

// export { initRedis, isLocked, incrementAttempts, resetAttempts };
// export default getClient;
import dotenv from "dotenv";
dotenv.config();

import { createClient } from "redis";
console.log("FINAL REDIS_URL:", process.env.REDIS_URL);

const REDIS_URL = process.env.REDIS_URL;

let client = null;

async function getClient() {
  if (client && client.isOpen) return client;

  client = createClient({
    url: REDIS_URL,
    socket: {
   //   tls: true,                  // Enable SSL/TLS
      rejectUnauthorized: false   // Needed for RedisLabs certificates
    }
  });

  client.on("error", (err) => {
    console.log("❌ Redis Error:", err?.message || err);
  });

  await client.connect();
  console.log("🌐 Redis connected successfully!");
  return client;
}

function attemptsKey(email) {
  return `login:attempts:${encodeURIComponent(email)}`;
}

function lockKey(email) {
  return `login:lock:${encodeURIComponent(email)}`;
}

export async function isLocked(email) {
  const c = await getClient();
  const ttl = await c.ttl(lockKey(email));
  return ttl > 0 ? ttl : 0;
}

export async function incrementAttempts(email, threshold = 5, lockSeconds = 30) {
  const c = await getClient();

  const aKey = attemptsKey(email);
  const lKey = lockKey(email);

  const attempts = await c.incr(aKey);

  if ((await c.ttl(aKey)) === -1) {
    await c.expire(aKey, lockSeconds);
  }

  if (attempts >= threshold) {
    await c.set(lKey, "1", { EX: lockSeconds });
    await c.del(aKey);
    return { attempts, locked: true, ttl: lockSeconds };
  }

  const ttl = await c.ttl(aKey);
  return { attempts, locked: false, ttl };
}

export async function resetAttempts(email) {
  const c = await getClient();
  await c.del(attemptsKey(email));
  await c.del(lockKey(email));
}

export async function initRedis() {
  await getClient();
}

export default getClient;
