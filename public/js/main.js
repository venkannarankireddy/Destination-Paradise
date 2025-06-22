// Firebase config & initialization
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore,
  collection,
  addDoc
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// Replace with your Firebase project config
const firebaseConfig = {
  apiKey: "AIzaSyB_fkGbun1XPlOAWTAbr8K0xkFt9a6HLAA",
  authDomain: "destinationparadise-b60a9.firebaseapp.com",
  projectId: "destinationparadise-b60a9",
  storageBucket: "destinationparadise-b60a9.appspot.com",
  messagingSenderId: "570882854683",
  appId: "1:570882854683:web:2fccfb482ebd134d7a8dbe",
  measurementId: "G-FLNNXKJNH4"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// 📝 Booking Form
const bookingForm = document.getElementById("bookForm");
if (bookingForm) {
  bookingForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    const getValue = (id) => document.getElementById(id)?.value.trim();
    const destination = getValue("destination");
    const dates = getValue("dates");
    const people = Number(getValue("people"));
    const name = getValue("name");
    const email = getValue("email");
    const countryCode = getValue("countryCode");
    const phone = getValue("phone");
    const maritalStatus = getValue("maritalStatus");

        // Basic validation
    if (
      !destination || !dates || isNaN(people) || people <= 0 ||
      !name || !email || !countryCode || !phone || !maritalStatus
    ) {
      alert("⚠️ Please fill in all fields correctly.");
      return;
    }


    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const selectedDate = new Date(dates);
    selectedDate.setHours(0, 0, 0, 0);

    if (selectedDate <= today) {
      alert("⚠️ Booking date must be at least one day after today.");
      return;
    }


    try {
      await addDoc(collection(db, "bookings"), {
        destination,
        dates,
        people,
        name,
        email,
        countryCode,
        phone,
        maritalStatus,
        bookedAt: new Date()
      });
      alert("✅ Booking submitted successfully!");
      bookingForm.reset();
    } catch (error) {
      console.error("❌ Firestore error:", error);
      alert("❌ Failed to submit booking: " + error.message);
    }
  });
}

// 🔐 Logout Button Handling
const logoutBtn = document.getElementById("logoutBtn");
onAuthStateChanged(auth, (user) => {
  if (logoutBtn) logoutBtn.style.display = user ? "inline-block" : "none";
});
if (logoutBtn) {
  logoutBtn.addEventListener("click", async () => {
    await signOut(auth);
    alert("🔓 Logged out successfully!");
    window.location.href = "/login";
  });
}

// 🎠 Home Carousel
const homeTrack = document.getElementById("homeCarouselTrack");
const homeSlides = document.querySelectorAll(".carousel-slide");
let homeIndex = 0;

function updateHomeCarousel() {
  if (homeTrack)
    homeTrack.style.transform = `translateX(-${homeIndex * 100}vw)`;
}
document.getElementById("homePrev")?.addEventListener("click", () => {
  homeIndex = (homeIndex - 1 + homeSlides.length) % homeSlides.length;
  updateHomeCarousel();
});
document.getElementById("homeNext")?.addEventListener("click", () => {
  homeIndex = (homeIndex + 1) % homeSlides.length;
  updateHomeCarousel();
});
setInterval(() => {
  homeIndex = (homeIndex + 1) % homeSlides.length;
  updateHomeCarousel();
}, 4000);

// 🧳 Travel Package Carousel
const slideContainer = document.querySelector("#travelCarousel .carousel-slides");
const slides = document.querySelectorAll("#travelCarousel .carousel-slides img");
let currentSlide = 0;

function showSlide(index) {
  if (!slideContainer || slides.length === 0) return;
  if (index < 0) currentSlide = slides.length - 1;
  else if (index >= slides.length) currentSlide = 0;
  else currentSlide = index;
  slideContainer.style.transform = `translateX(-${currentSlide * 100}%)`;
}
document.getElementById("nextSlide")?.addEventListener("click", () => showSlide(currentSlide + 1));
document.getElementById("prevSlide")?.addEventListener("click", () => showSlide(currentSlide - 1));
slides.forEach((img, idx) => {
  img.addEventListener("click", () => showSlide(idx + 1));
});
setInterval(() => {
  showSlide(currentSlide + 1);
}, 3000);
