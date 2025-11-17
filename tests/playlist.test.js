import mongoose from "mongoose";
import request from "supertest";
import { encrypt } from "../utils/encryption.js";

// Test DB (local Mongo) - adjust if you want in-memory DB
const MONGO_TEST_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/spotify_clone";

let app; // will be dynamically imported after setting env
let agent;
let User;
let Song;

beforeAll(async () => {
  // ensure server uses the test DB
  process.env.MONGODB_URI = MONGO_TEST_URI;
  process.env.NODE_ENV = "test";

  // import app after env is set so server/session store use test DB
  ({ default: app } = await import("../server.js"));

  // connect mongoose
  await mongoose.connect(MONGO_TEST_URI);

  // import models
  ({ default: User } = await import("../models/User.js"));
  ({ default: Song } = await import("../models/Song.js"));

  // clean collections
  await User.deleteMany({});
  await Song.deleteMany({});

  // create test user with AES-encrypted password
  const encryptedPassword = encrypt("pass123");
  const user = new User({ username: "testuser", email: "test@example.com", password: encryptedPassword, playlists: [] });
  await user.save();

  // create a sample song
  const song = new Song({ title: "Test Song", artist: "Tester", file: "/uploads/songs/test.mp3", thumbnail: "/uploads/thumbnails/test.jpg" });
  await song.save();

  // use an agent to persist cookies (session)
  agent = request.agent(app);
  // log in to create session
  await agent.post("/login").type("form").send({ email: "test@example.com", password: "pass123" });
});

afterAll(async () => {
  // clean up test DB
  await User.deleteMany({});
  await Song.deleteMany({});
  // ensure mongoose fully disconnects to allow Jest to exit
  await mongoose.disconnect();
});

describe("🎵 Playlist Routes (integration)", () => {
  test("GET /playlists → should render playlist page", async () => {
    const res = await agent.get("/playlists");
    expect(res.statusCode).toBe(200);
    expect(res.text).toContain("Your Playlists");
  });

  test("POST /playlists → should require playlist name", async () => {
    const res = await agent.post("/playlists").type("form").send({});
    expect(res.statusCode).toBe(200);
    expect(res.text).toContain("Playlist name required");
  });

  test("POST /playlists with valid name → should redirect and allow add/remove song", async () => {
    // Create playlist
    let res = await agent.post("/playlists").type("form").send({ name: "Chill Beats" });
    expect(res.statusCode).toBe(302);
    expect(res.header.location).toBe("/playlists");

    // Get the user's playlists to find the created playlist id
    const user = await User.findOne({ email: "test@example.com" });
    expect(user.playlists.length).toBeGreaterThan(0);
    const playlistId = user.playlists[0]._id.toString();

    // find a song
    const song = await Song.findOne({ title: "Test Song" });
    expect(song).toBeTruthy();

    // Add song to playlist
    res = await agent.post(`/playlists/${playlistId}/add/${song._id}`);
    expect(res.statusCode).toBe(302);

    // View playlist and ensure song present
    res = await agent.get(`/playlists/view/${playlistId}`);
    expect(res.statusCode).toBe(200);
    expect(res.text).toContain("Test Song");

    // Remove song from playlist
    res = await agent.post(`/playlists/${playlistId}/remove/${song._id}`);
    expect(res.statusCode).toBe(302);

    // View playlist: song should no longer be in the playlist area
    res = await agent.get(`/playlists/view/${playlistId}`);
    expect(res.statusCode).toBe(200);
    expect(res.text).toContain("Your playlist is empty");
  });
});
