const video = document.getElementById("launch");
const arrow = document.getElementById("arrow");
arrow.src="/assets/arrow.png";
 
window.addEventListener("click", function(){
   /** video.play();*/
  if (!video.paused){
    video.pause();
  } else {
    video.play();
  } 
});

