import mongoose from "mongoose";

const songSchema = new mongoose.Schema({
  title: { type: String, required: true },
  artist: { type: String, required: true },
  file: { type: String, required: true },
  album: { type: mongoose.Schema.Types.ObjectId, ref: "Album" }, // <-- new
  thumbnail: String,   // path to image
});

export default mongoose.model("Song", songSchema);
