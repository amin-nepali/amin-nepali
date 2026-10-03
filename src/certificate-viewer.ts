import certificate7098 from "../certificate_CION-7098.png";
import certificate13750 from "../certificate_CION-13750.png";

const certificates: Record<string, { title: string; src: string }> = {
  "7098": {
    title: "Web Design Certificate — 7098",
    src: certificate7098,
  },
  "13750": {
    title: "CCNA Certificate — 13750",
    src: certificate13750,
  },
};

const params = new URLSearchParams(window.location.search);
const certificate = certificates[params.get("certificate") ?? "7098"] ?? certificates["7098"];
const image = document.getElementById("cert-image");
const title = document.getElementById("viewer-title");

if (image instanceof HTMLImageElement) {
  image.src = certificate.src;
  image.alt = certificate.title;
}

if (title) {
  title.textContent = certificate.title;
}

document.addEventListener("contextmenu", (event) => event.preventDefault());
document.addEventListener("dragstart", (event) => event.preventDefault());
document.addEventListener("selectstart", (event) => event.preventDefault());

document.addEventListener("keydown", (event) => {
  const blocked = ["s", "S", "p", "P", "c", "C", "u", "U"];
  if (
    event.key === "PrintScreen"
    || event.key === "F12"
    || (blocked.includes(event.key) && (event.ctrlKey || event.metaKey))
  ) {
    event.preventDefault();
  }
});

window.addEventListener("beforeprint", (event) => event.preventDefault());
