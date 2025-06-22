document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("bookForm");
  const resDiv = document.getElementById("formResponse");

  if (!form || !resDiv) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const getValue = (id) => document.getElementById(id)?.value.trim();

    const destination = getValue("destination");
    const fromDate = document.getElementById("fromDate")?.value;
    const toDate = document.getElementById("toDate")?.value;
    const people = Number(getValue("people"));
    const name = getValue("name");
    const email = getValue("email");
    const countryCode = getValue("countryCode");
    const phone = getValue("phone");
    const maritalStatus = getValue("maritalStatus");

    // Validation
    if (
      !destination || !fromDate || !toDate || isNaN(people) || people <= 0 ||
      !name || !email || !countryCode || !phone || !maritalStatus
    ) {
      resDiv.textContent = "⚠️ Please fill out all fields correctly.";
      resDiv.style.color = "red";
      form.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }

    // Date validation
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const from = new Date(fromDate);
    const to = new Date(toDate);
    from.setHours(0, 0, 0, 0);
    to.setHours(0, 0, 0, 0);

    if (from <= today) {
      resDiv.textContent = "⚠️ 'From Date' must be at least tomorrow.";
      resDiv.style.color = "red";
      return;
    }

    if (to <= from) {
      resDiv.textContent = "⚠️ 'To Date' must be after 'From Date'.";
      resDiv.style.color = "red";
      return;
    }

    const data = {
      destination,
      fromDate,
      toDate,
      people,
      name,
      email,
      countryCode,
      phone,
      maritalStatus,
      bookedAt: new Date().toISOString()
    };

    // UI feedback
    resDiv.textContent = "⏳ Booking in progress...";
    resDiv.style.color = "#333";

    try {
      const response = await fetch("/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data)
      });

      const result = await response.json();

      if (response.ok) {
        resDiv.textContent = "✅ Booking successful!";
        resDiv.style.color = "green";
        form.reset();
      } else {
        resDiv.textContent = `❌ ${result.message || "Booking failed."}`;
        resDiv.style.color = "red";
      }
    } catch (error) {
      console.error("Error during booking:", error);
      resDiv.textContent = "❌ Network error. Please try again.";
      resDiv.style.color = "red";
    }
  });
});
