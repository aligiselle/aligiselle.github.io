const video = document.getElementById("launch");

video.onload = function(){
  video.play();
  console.log("clicked");
}