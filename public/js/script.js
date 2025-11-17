console.log("Spotify Clone Loaded 🎵");

// Log when a song is clicked
document.querySelectorAll(".song").forEach(song => {
  song.addEventListener("click", () => {
    console.log("Clicked:", song.querySelector("p").innerText);
  });
});

// Optional: Highlight song when added to playlist
document.querySelectorAll(".song form button").forEach(button => {
  button.addEventListener("click", (e) => {
    // e.preventDefault(); // Don't prevent submit if you want backend to handle
    const songDiv = e.target.closest(".song");
    songDiv.style.backgroundColor = "#222"; // Simple visual feedback
    songDiv.style.color = "#fff";
  });
});

const createPlaylistLink = document.getElementById("createPlaylistSidebar");
  if(createPlaylistLink){
    createPlaylistLink.addEventListener("click", () => {
      const name = prompt("Enter playlist name:");
      if(name){
        const form = document.createElement("form");
        form.method = "POST";
        form.action = "/playlists";
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = "name";
        input.value = name;
        form.appendChild(input);
        document.body.appendChild(form);
        form.submit();
      }
    });
  }

// Playlist creation handled in EJS using prompt
// No additional JS needed since form is dynamically created and submitted
