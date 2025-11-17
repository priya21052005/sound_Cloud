import express from "express";
import dotenv from "dotenv";
import expressLayouts from "express-ejs-layouts";
import mongoose from "mongoose";
import session from "express-session";
import MongoStore from "connect-mongo";
import path from "path";
import { fileURLToPath } from "url";
import fileUpload from "express-fileupload";
import fs from "fs";

import User from "./models/User.js";
import Song from "./models/Song.js";
import Album from "./models/Album.js";
import { initRedis, isLocked, incrementAttempts, resetAttempts } from "./utils/redisLock.js";
import { encrypt, decrypt } from "./utils/encryption.js";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure upload directories exist
const uploadsDir = path.join(__dirname, "uploads");
const songsDir = path.join(uploadsDir, "songs");
const thumbnailsDir = path.join(uploadsDir, "thumbnails");
[songsDir, thumbnailsDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const app = express();
const PORT = process.env.PORT || 5000;

// EJS
app.use(expressLayouts);
app.set("layout", "layout");
app.set("view engine", "ejs");

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use(fileUpload());

// Session
// In test environment, avoid creating a persistent Mongo-backed session store
const sessionStore = process.env.NODE_ENV === 'test' ? undefined : MongoStore.create({ mongoUrl: process.env.MONGODB_URI });
app.use(
  session({
    secret: process.env.SESSION_SECRET || "spotify_secret",
    resave: false,
    saveUninitialized: false,
    store: sessionStore,
    cookie: { maxAge: 1000 * 60 * 60 },
  })
);

// MongoDB
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("MongoDB connected ✅"))
  .catch((err) => console.log(err));

// Note: Redis will be used on-demand inside helpers. We avoid forcing a connection
// at startup so the app can run even if Redis is unreachable (helpers fail-open).

// Expose user/admin/albums
app.use(async (req, res, next) => {
  res.locals.user = req.session.user;
  res.locals.admin = req.session.admin;

  try {
    res.locals.albums = await Album.find().populate("songs");
  } catch {
    res.locals.albums = [];
  }

  next();
});

// Protect routes
function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.admin) return res.redirect("/login");
  next();
}

// ================= LOGIN / REGISTER =================
app.get("/login", (req, res) => res.render("login", { title: "Login" }));
app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  // Admin login
  if (email === process.env.ADMIN_EMAIL && password === process.env.ADMIN_PASSWORD) {
    req.session.admin = true;
    return res.redirect("/admin");
  }

  // Check if account is locked (by Redis)
  try {
    const lockTtl = await isLocked(email);
    if (lockTtl && lockTtl > 0) {
      return res.status(200).render("login", {
        title: "Login",
        error: `Account locked due to too many failed attempts. Try again in ${lockTtl} seconds.`,
        email: email || "",
        lockTtl: Number(lockTtl),
      });
    }
  } catch (err) {
    // ignore Redis errors and proceed (fail open)
    console.warn("Redis lock check failed:", err && err.message ? err.message : err);
  }

  // User login
  const user = await User.findOne({ email });
  if (!user) {
    // If the email is not registered, show inline error (no attempt increment)
    return res.status(200).render("login", {
      title: "Login",
      error: "This email address does not exist. Please register first.",
      email: email || "",
    });
  }

  // If user exists, compare decrypted password using AES encryption
  let validPassword = false;
  try {
    const decrypted = decrypt(user.password);
    validPassword = decrypted && decrypted === password;
  } catch (e) {
    console.warn('Password check error:', e && e.message ? e.message : e);
    validPassword = false;
  }

  if (validPassword) {
    // successful login -> reset attempts and continue
    try {
      await resetAttempts(email);
    } catch (err) {
      console.warn("Failed to reset login attempts:", err && err.message ? err.message : err);
    }
    req.session.user = user;
    return res.redirect("/");
  }

  // failed login -> increment attempts and possibly lock
  try {
    const { attempts, locked, ttl } = await incrementAttempts(email);
    if (locked) {
      return res.status(200).render("login", {
        title: "Login",
        error: `Account locked due to too many failed attempts. Try again in ${ttl} seconds.`,
        email: email || "",
        lockTtl: Number(ttl),
      });
    }
    const remaining = Math.max(0, 5 - attempts);
    return res.status(200).render("login", {
      title: "Login",
      error: `Invalid email or password. ${remaining} attempts left before temporary lock.`,
      email: email || "",
    });
  } catch (err) {
    console.warn("Failed to increment login attempts:", err && err.message ? err.message : err);
    return res.status(200).render("login", {
      title: "Login",
      error: "Invalid email or password",
      email: email || "",
    });
  }
});

app.get("/register", (req, res) => res.render("register", { title: "Register" }));
app.post("/register", async (req, res) => {
  const { username, email, password } = req.body;
  // Validate duplicate email
  const existing = await User.findOne({ email });
  if (existing) {
    return res.status(200).render("register", {
      title: "Register",
      error: "This email is already in use — please register with another email.",
      username: username || "",
      email: email || "",
    });
  }

  // Encrypt the password before saving (note: reversible encryption)
  const encryptedPassword = encrypt(password);
  const newUser = new User({ username, email, password: encryptedPassword, playlists: [] });
  await newUser.save();
  res.redirect("/login");
});

app.get("/logout", (req, res) => req.session.destroy(() => res.redirect("/login")));

// ================= ADMIN ROUTES =================
app.get("/admin", requireAdmin, async (req, res) => {
  const users = await User.find();
  const albums = await Album.find().populate("songs");
  res.render("admin-panel", { title: "Admin Panel", users, albums });
});

// Create album
app.get("/admin/albums/create", requireAdmin, (req, res) =>
  res.render("admin-album-create", { title: "Add Album" })
);
app.post("/admin/albums/create", requireAdmin, async (req, res) => {
  const { name, artist } = req.body;
  if (!name || !artist) return res.send("Album name and artist required");

  const album = new Album({ name, artist, songs: [] });
  await album.save();
  res.redirect("/admin");
});

// Delete album (with cleanup)
app.post("/admin/albums/delete/:albumId", requireAdmin, async (req, res) => {
  const { albumId } = req.params;
  const album = await Album.findById(albumId).populate("songs");
  if (!album) return res.send("Album not found");

  for (const song of album.songs) {
    // Delete files
    [song.file, song.thumbnail].forEach(filePath => {
      if (!filePath) return;
      const fullPath = path.join(__dirname, filePath);
      if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    });

    // Remove from playlists
    await User.updateMany(
      { "playlists.songs": song._id },
      { $pull: { "playlists.$[].songs": song._id } }
    );

    await Song.findByIdAndDelete(song._id);
  }

  await Album.findByIdAndDelete(albumId);
  res.redirect("/admin");
});

// Create song
app.get("/admin/songs/create", requireAdmin, async (req, res) => {
  const albums = await Album.find();
  res.render("admin-song-create", { title: "Add Song", albums });
});
app.post("/admin/songs/create", requireAdmin, async (req, res) => {
  const { title, artist, albumId } = req.body;
  if (!title || !artist || !albumId || !req.files?.audio || !req.files?.thumbnail)
    return res.send("All fields required");

  const audioFile = req.files.audio;
  const thumbnailFile = req.files.thumbnail;

  const audioPath = path.join(songsDir, audioFile.name);
  const thumbnailPath = path.join(thumbnailsDir, thumbnailFile.name);

  await audioFile.mv(audioPath);
  await thumbnailFile.mv(thumbnailPath);

  const song = new Song({
    title,
    artist,
    file: "/uploads/songs/" + audioFile.name,
    thumbnail: "/uploads/thumbnails/" + thumbnailFile.name,
  });
  await song.save();

  const album = await Album.findById(albumId);
  album.songs.push(song._id);
  await album.save();

  res.redirect("/admin");
});

// Delete song
app.post("/admin/songs/delete/:songId", requireAdmin, async (req, res) => {
  const { songId } = req.params;
  const song = await Song.findById(songId);
  if (song) {
    [song.file, song.thumbnail].forEach(filePath => {
      if (!filePath) return;
      const fullPath = path.join(__dirname, filePath);
      if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    });

    await Album.updateMany({ songs: songId }, { $pull: { songs: songId } });
    await User.updateMany(
      { "playlists.songs": songId },
      { $pull: { "playlists.$[].songs": songId } }
    );

    await Song.findByIdAndDelete(songId);
  }
  res.redirect("/admin");
});

// Remove song from album only
app.post("/admin/albums/:albumId/remove/:songId", requireAdmin, async (req, res) => {
  const { albumId, songId } = req.params;
  const album = await Album.findById(albumId);
  if (!album) return res.send("Album not found");
  album.songs.pull(songId);
  await album.save();
  res.redirect("/admin");
});

// Add song to album
app.post("/admin/albums/:albumId/add-song", requireAdmin, async (req, res) => {
  const { albumId } = req.params;
  const { title, artist } = req.body;
  if (!title || !artist || !req.files?.audio || !req.files?.thumbnail)
    return res.send("All fields required");

  const audioFile = req.files.audio;
  const thumbnailFile = req.files.thumbnail;

  const audioPath = path.join(songsDir, audioFile.name);
  const thumbnailPath = path.join(thumbnailsDir, thumbnailFile.name);

  await audioFile.mv(audioPath);
  await thumbnailFile.mv(thumbnailPath);

  const song = new Song({
    title,
    artist,
    file: "/uploads/songs/" + audioFile.name,
    thumbnail: "/uploads/thumbnails/" + thumbnailFile.name,
  });
  await song.save();

  const album = await Album.findById(albumId);
  album.songs.push(song._id);
  await album.save();

  res.redirect("/admin");
});

// ================= USER ROUTES =================
app.get("/", requireLogin, async (req, res) => {
  const songs = await Song.find();
  const albums = await Album.find().populate("songs");
  res.render("index", { title: "Spotify Clone", songs, albums });
});

// Playlists
app.post("/playlists", requireLogin, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.send("Playlist name required");

  try {
    const user = await User.findById(req.session.user._id);
    if (!user) return res.send("User not found");
    
    user.playlists.push({ name, songs: [] });
    await user.save();
    res.redirect("/playlists");
  } catch (err) {
    console.error("Error creating playlist:", err);
    res.status(500).send("Error creating playlist: " + err.message);
  }
});

app.get("/playlists", requireLogin, async (req, res) => {
  const user = await User.findById(req.session.user._id);
  const songs = await Song.find();
  const playlistsWithSongs = user.playlists.map((pl) => ({
    _id: pl._id,
    name: pl.name,
    songs: pl.songs.map((songId) =>
      songs.find((s) => s._id.toString() === songId.toString())
    ),
  }));
  res.render("playlists", { title: "Your Playlists", playlists: playlistsWithSongs, songs });
});

app.get("/playlists/view/:playlistId", requireLogin, async (req, res) => {
  const { playlistId } = req.params;
  const user = await User.findById(req.session.user._id);
  const playlist = user.playlists.id(playlistId);
  if (!playlist) return res.send("Playlist not found");

  const songs = await Song.find();
  const playlistSongs = playlist.songs.map((songId) =>
    songs.find((s) => s._id.toString() === songId.toString())
  );
  res.render("playlist-view", {
    title: playlist.name,
    playlist: { _id: playlist._id, name: playlist.name, songs: playlistSongs },
    songs,
  });
});

app.post("/playlists/:playlistId/add/:songId", requireLogin, async (req, res) => {
  const { playlistId, songId } = req.params;
  try {
    const user = await User.findById(req.session.user._id);
    if (!user) return res.send("User not found");
    
    const playlist = user.playlists.id(playlistId);
    if (!playlist) return res.send("Playlist not found");
    
    if (!playlist.songs.includes(songId)) playlist.songs.push(songId);
    await user.save();
    res.redirect("/playlists/view/" + playlistId);
  } catch (err) {
    console.error("Error adding song to playlist:", err);
    res.status(500).send("Error adding song: " + err.message);
  }
});

app.post("/playlists/:playlistId/remove/:songId", requireLogin, async (req, res) => {
  const { playlistId, songId } = req.params;
  try {
    const user = await User.findById(req.session.user._id);
    if (!user) return res.send("User not found");
    
    const playlist = user.playlists.id(playlistId);
    if (!playlist) return res.send("Playlist not found");
    
    playlist.songs.pull(songId);
    await user.save();
    res.redirect("/playlists/view/" + playlistId);
  } catch (err) {
    console.error("Error removing song from playlist:", err);
    res.status(500).send("Error removing song: " + err.message);
  }
});

// Delete entire playlist
app.post("/playlists/:playlistId/delete", requireLogin, async (req, res) => {
  const { playlistId } = req.params;
  try {
    const user = await User.findById(req.session.user._id);
    if (!user) return res.send("User not found");
    
    user.playlists.pull(playlistId);
    await user.save();
    res.redirect("/playlists");
  } catch (err) {
    console.error("Error deleting playlist:", err);
    res.status(500).send("Error deleting playlist: " + err.message);
  }
});

// Player
app.get("/player/:id", requireLogin, async (req, res) => {
  const song = await Song.findById(req.params.id);
  if (!song) return res.send("Song not found");
  const songs = await Song.find();
  res.render("player", { title: song.title, song, songs });
});

// Search
app.get("/search", requireLogin, async (req, res) => {
  const query = req.query.q || "";
  const songs = query ? await Song.find({ title: { $regex: query, $options: "i" } }) : [];
  res.render("search", { title: `Search: ${query}`, songs });
});

// Album view
app.get("/album/:id", requireLogin, async (req, res) => {
  const album = await Album.findById(req.params.id).populate("songs");
  if (!album) return res.send("Album not found");
  res.render("album-view", { title: album.name, album });
});

// Start server
// app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));


if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}

export default app;
