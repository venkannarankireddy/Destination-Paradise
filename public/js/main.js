// Destination Paradise — Main Client Utilities
document.addEventListener("DOMContentLoaded", () => {
  // 1. Mobile navigation menu toggle
  const mobileToggleBtn = document.getElementById("mobileNavToggle");
  const navMenu = document.getElementById("navMenu");

  if (mobileToggleBtn && navMenu) {
    mobileToggleBtn.addEventListener("click", () => {
      const isExpanded = mobileToggleBtn.getAttribute("aria-expanded") === "true";
      mobileToggleBtn.setAttribute("aria-expanded", !isExpanded);
      navMenu.classList.toggle("is-open");
      mobileToggleBtn.classList.toggle("is-active");
    });

    // Close menu when clicking outside
    document.addEventListener("click", (e) => {
      if (!navMenu.contains(e.target) && !mobileToggleBtn.contains(e.target) && navMenu.classList.contains("is-open")) {
        navMenu.classList.remove("is-open");
        mobileToggleBtn.setAttribute("aria-expanded", "false");
        mobileToggleBtn.classList.remove("is-active");
      }
    });
  }

  // 2. Set minimum date for all date pickers to tomorrow
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split("T")[0];

  document.querySelectorAll("input[type='date']").forEach((picker) => {
    if (!picker.getAttribute("min")) {
      picker.min = tomorrowStr;
    }
  });

  // 3. Auto-dismiss flash notifications after 6 seconds
  document.querySelectorAll(".flash-dismissible").forEach((alert) => {
    setTimeout(() => {
      alert.style.opacity = "0";
      alert.style.transform = "translateY(-8px)";
      setTimeout(() => alert.remove(), 400);
    }, 6000);

    const closeBtn = alert.querySelector(".flash-close");
    if (closeBtn) {
      closeBtn.addEventListener("click", () => {
        alert.remove();
      });
    }
  });

  // 4. Form double-submission prevention (for standard HTML forms)
  document.querySelectorAll("form").forEach((form) => {
    form.addEventListener("submit", (e) => {
      const submitBtn = form.querySelector("button[type='submit']:not(.no-disable)");
      if (submitBtn && !form.dataset.submitting) {
        form.dataset.submitting = "true";
        submitBtn.dataset.originalHtml = submitBtn.innerHTML;
        // Don't disable immediately if form validation fails
        setTimeout(() => {
          if (!e.defaultPrevented) {
            submitBtn.disabled = true;
            submitBtn.style.opacity = "0.75";
            submitBtn.innerHTML = "<span>⏳ Processing...</span>";
          } else {
            delete form.dataset.submitting;
          }
        }, 10);
      }
    });
  });
});

