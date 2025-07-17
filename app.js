const video = document.getElementById("launch");
let arrow = document.getElementById("arrow");

window.addEventListener("click", function(){
  if (video && !video.paused){
    video.pause();
  } else {
    video.play();
  }
});