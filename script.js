"use strict";

const API_CONFIG = {
  baseUrl: "https://wandermark-api.crazyyyyy-travel.workers.dev/",
};

const OWNER_ACCESS = {
  sessionKey: "longnh",
};

const Storage = (() => {
  const apiRoot = API_CONFIG.baseUrl.replace(/\/$/, "");
  let memoriesCache = null;
  let memoriesRequest = null;

  function buildUrl(path) {
    return `${apiRoot}${path}`;
  }

  function getOwnerPasscode() {
    return sessionStorage.getItem(OWNER_ACCESS.sessionKey) || "";
  }

  function clearOwnerPasscode() {
    sessionStorage.removeItem(OWNER_ACCESS.sessionKey);
  }

  function normalizeMemory(memory) {
    return {
      ...memory,
      lat: Number(memory.lat),
      lng: Number(memory.lng),
      createdAt: Number(memory.createdAt),
    };
  }

  async function request(path, options = {}, requiresOwner = false) {
    const headers = new Headers(options.headers || {});

    if (requiresOwner) {
      const passcode = getOwnerPasscode();
      if (!passcode) {
        throw new Error("Unlock owner mode first.");
      }
      headers.set("x-owner-passcode", passcode);
    }

    let response;
    try {
      response = await fetch(buildUrl(path), {
        ...options,
        headers,
      });
    } catch {
      throw new Error(
        "Could not reach the memory API. Deploy the Cloudflare Worker and set API_CONFIG.baseUrl if needed.",
      );
    }

    if (response.status === 401) {
      clearOwnerPasscode();
      throw new Error("Incorrect passcode.");
    }

    if (!response.ok) {
      let message = `Request failed with status ${response.status}.`;
      try {
        const payload = await response.json();
        if (payload && payload.error) {
          message = payload.error;
        }
      } catch {}
      throw new Error(message);
    }

    return response;
  }

  async function getAll(forceRefresh = false) {
    if (!forceRefresh && memoriesCache) {
      return [...memoriesCache];
    }

    if (!forceRefresh && memoriesRequest) {
      const memories = await memoriesRequest;
      return [...memories];
    }

    memoriesRequest = request("/api/memories")
      .then((response) => response.json())
      .then((payload) => {
        const memories = Array.isArray(payload.memories)
          ? payload.memories.map(normalizeMemory)
          : [];

        memoriesCache = memories;
        return memories;
      })
      .finally(() => {
        memoriesRequest = null;
      });

    const memories = await memoriesRequest;
    return [...memories];
  }

  async function getById(id) {
    const memories = await getAll();
    return memories.find((memory) => memory.id === id) || null;
  }

  async function create(input) {
    const formData = new FormData();
    formData.append("caption", input.caption);
    formData.append("date", input.date);
    formData.append("category", input.category);
    formData.append("lat", String(input.lat));
    formData.append("lng", String(input.lng));
    formData.append("createdAt", String(input.createdAt));
    formData.append("imageCount", String(input.images.length));
    input.images.forEach((img, i) => {
      formData.append(`image_${i}`, img.imageFile);
      formData.append(`thumbnail_${i}`, img.thumbnailFile);
    });

    const response = await request(
      "/api/memories",
      {
        method: "POST",
        body: formData,
      },
      true,
    );
    const payload = await response.json();
    const memory = normalizeMemory(payload.memory);

    memoriesCache = memoriesCache ? [...memoriesCache, memory] : [memory];
    return memory;
  }

  async function remove(id) {
    await request(
      `/api/memories/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
      },
      true,
    );

    if (memoriesCache) {
      memoriesCache = memoriesCache.filter((memory) => memory.id !== id);
    }
  }

  async function update(id, fields) {
    const formData = new FormData();
    if (fields.caption !== undefined) formData.append("caption", fields.caption);
    if (fields.date !== undefined) formData.append("date", fields.date);
    if (fields.category !== undefined) formData.append("category", fields.category);
    if (fields.keptImages) formData.append("keptImages", JSON.stringify(fields.keptImages));
    
    if (fields.newImages && fields.newImages.length > 0) {
      formData.append("newImageCount", String(fields.newImages.length));
      fields.newImages.forEach((img, i) => {
        formData.append(`new_image_${i}`, img.imageFile);
        formData.append(`new_thumbnail_${i}`, img.thumbnailFile);
      });
    }

    const response = await request(
      `/api/memories/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: formData,
      },
      true,
    );
    const payload = await response.json();
    const updatedMemory = normalizeMemory(payload.memory);

    if (memoriesCache) {
      const index = memoriesCache.findIndex((memory) => memory.id === id);
      if (index !== -1) {
        memoriesCache[index] = { ...memoriesCache[index], ...updatedMemory };
      }
    }
    return updatedMemory;
  }

  async function verifyOwnerPasscode(passcode) {
    if (!passcode) {
      throw new Error("Enter your passcode.");
    }

    await request("/api/session", {
      method: "POST",
      headers: { "x-owner-passcode": passcode },
    });

    sessionStorage.setItem(OWNER_ACCESS.sessionKey, passcode);
  }

  function isOwnerSessionUnlocked() {
    return Boolean(getOwnerPasscode());
  }

  function getCachedCount() {
    return memoriesCache ? memoriesCache.length : null;
  }

  return {
    clearOwnerPasscode,
    create,
    getAll,
    getById,
    getCachedCount,
    isOwnerSessionUnlocked,
    remove,
    update,
    verifyOwnerPasscode,
  };
})();

const MapModule = (() => {
  let map = null;

  const EU_VIEW = { center: [48, 10], zoom: 5 };
  const VIETNAM_VIEW = { center: [16.5, 106.5], zoom: 6 };

  async function init() {
    map = L.map("map", {
      center: VIETNAM_VIEW.center,
      zoom: VIETNAM_VIEW.zoom,
      zoomControl: true,
      maxZoom: 18,
      minZoom: 2,
    });

    L.tileLayer("https://{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}", {
      subdomains: ["mt0", "mt1", "mt2", "mt3"],
      attribution:
        '&copy; <a href="https://www.google.com/maps">Google Maps</a>',
    }).addTo(map);

    L.geoJSON(await vietnamGeoJSON(), {
      style: {
        color: "#22d3ee",
        weight: 1.5,
        opacity: 0.7,
        fillColor: "#22d3ee",
        fillOpacity: 0.07,
        dashArray: "6 4",
      },
    }).addTo(map);

    addTerritoryFlags();
    map.zoomControl.setPosition("bottomright");
    return map;
  }

  // Vietnam's archipelagos, marked with the national flag at their approximate centres
  const TERRITORIES = [
    { name: "Quần đảo Hoàng Sa", latlng: [16.5, 112.0] },
    { name: "Quần đảo Trường Sa", latlng: [9.9, 114.3] },
  ];
  const FLAG_SVG = `
    <svg viewBox="0 0 32 40" aria-hidden="true">
      <line x1="3" y1="2" x2="3" y2="38" stroke="#cbd5e1" stroke-width="2" stroke-linecap="round" />
      <rect x="4" y="3" width="24" height="16" rx="1.5" fill="#da251d" />
      <polygon points="16.00,5.60 17.21,9.33 21.14,9.33 17.96,11.64 19.17,15.37 16.00,13.06 12.83,15.37 14.04,11.64 10.86,9.33 14.79,9.33" fill="#ffff00" />
    </svg>`;

  function addTerritoryFlags() {
    const icon = L.divIcon({
      html: FLAG_SVG,
      className: "territory-flag",
      iconSize: [32, 40],
      iconAnchor: [3, 38], // the pole's foot sits on the coordinate
    });

    TERRITORIES.forEach(({ name, latlng }) => {
      L.marker(latlng, {
        icon,
        interactive: false, // decoration: clicks fall through to the map
        keyboard: false,
        zIndexOffset: -1000, // keep memory markers above the flags
      })
        .bindTooltip(name, {
          permanent: true,
          direction: "right",
          offset: [26, -20],
          className: "territory-label",
        })
        .addTo(map);
    });
  }

  function flyToEurope() {
    map.flyTo(EU_VIEW.center, EU_VIEW.zoom, {
      duration: 1.2,
      easeLinearity: 0.3,
    });
  }

  function flyToVietnam() {
    map.flyTo(VIETNAM_VIEW.center, VIETNAM_VIEW.zoom, {
      duration: 1.2,
      easeLinearity: 0.3,
    });
  }

  function flyTo(lat, lng, zoom = 13) {
    map.flyTo([lat, lng], zoom, { duration: 1.0, easeLinearity: 0.3 });
  }

  function getMap() {
    return map;
  }

  async function vietnamGeoJSON() {
    try {
      const response = await fetch("./geo-json/vn.json");
      if (!response.ok) throw new Error("Failed to load GeoJSON");
      return await response.json();
    } catch (e) {
      console.error(e);
      return { type: "FeatureCollection", features: [] };
    }
  }

  return { init, flyToEurope, flyToVietnam, flyTo, getMap };
})();

const Markers = (() => {
  let clusterGroup = null;
  const markerMap = {};
  const memoryMap = {};

  const CATEGORY_LABEL = {
    travel: "Travel",
    food: "Food",
    friends: "Friends",
    nature: "Nature",
    culture: "Culture",
  };

  function init(map) {
    clusterGroup = L.markerClusterGroup({
      maxClusterRadius: 50,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
      zoomToBoundsOnClick: true,
    });
    map.addLayer(clusterGroup);
  }

  function markerInitial(memory) {
    const label = CATEGORY_LABEL[memory.category] || "Memory";
    return label.charAt(0).toUpperCase();
  }

  function markerCaption(memory) {
    return escHtml(memory.caption || "Untitled memory");
  }

  function createIcon(memory) {
    const catClass = `marker-cat-${memory.category || "travel"}`;
    const imgSrc = memory.images && memory.images.length ? memory.images[0].thumbnail : null;
    const imgInner = imgSrc
      ? `<img src="${imgSrc}" alt="" />`
      : `<div class="marker-pin-default">${markerInitial(memory)}</div>`;

    return L.divIcon({
      html: `
        <div class="custom-marker ${catClass}">
          <div class="marker-pin">${imgInner}</div>
          <div class="marker-tail"></div>
        </div>`,
      className: "",
      iconSize: [40, 48],
      iconAnchor: [20, 48],
      popupAnchor: [0, -50],
    });
  }

  function buildPopupHtml(memory) {
    const caption = memory.caption || "Untitled memory";
    const date = memory.date
      ? new Date(memory.date).toLocaleDateString("en-GB", {
          day: "numeric",
          month: "short",
          year: "numeric",
        })
      : "";
    const category = CATEGORY_LABEL[memory.category] || "Memory";
    const imgSrc = memory.images && memory.images.length ? memory.images[0].thumbnail : null;
    const imgTag = imgSrc
      ? `<img src="${imgSrc}" alt="" />`
      : "";

    return `
      <div class="popup-inner">
        ${imgTag}
        <div class="popup-caption">${escHtml(caption)}</div>
        <div class="popup-meta">${escHtml(category)} ${date ? "&middot; " + date : ""}</div>
        <div class="popup-actions">
          <button class="popup-btn popup-btn-open" data-action="open" data-id="${memory.id}">Open</button>
          ${UI.isEditingEnabled() ? `<button class="popup-btn" data-action="delete" data-id="${memory.id}">Delete</button>` : ""}
        </div>
      </div>
    `;
  }

  function createMarker(memory) {
    memoryMap[memory.id] = memory;

    const marker = L.marker([memory.lat, memory.lng], {
      icon: createIcon(memory),
    });

    marker.on("click", () => {
      ViewModal.open(memory.id);
    });

    marker.bindTooltip(markerCaption(memory), {
      permanent: true,
      direction: "right",
      offset: [14, -28],
      className: "memory-marker-caption",
    });
    marker.bindPopup(buildPopupHtml(memory), { maxWidth: 260, className: "" });
    marker.on("popupopen", () => {
      marker.setPopupContent(buildPopupHtml(memoryMap[memory.id]));
      const container = marker.getPopup().getElement();
      const openBtn = container.querySelector('[data-action="open"]');
      const delBtn = container.querySelector('[data-action="delete"]');
      if (openBtn)
        openBtn.addEventListener("click", () => ViewModal.open(memory.id));
      if (delBtn)
        delBtn.addEventListener("click", () => Markers.deleteById(memory.id));
    });

    markerMap[memory.id] = marker;
    return marker;
  }

  function addMarker(memory) {
    clusterGroup.addLayer(createMarker(memory));
  }

  function addMarkers(memories) {
    const markers = memories.map(createMarker);
    clusterGroup.addLayers(markers);
  }

  function removeMarker(id) {
    if (markerMap[id]) {
      clusterGroup.removeLayer(markerMap[id]);
      delete markerMap[id];
    }
    delete memoryMap[id];
  }

  function refreshPopups() {
    Object.keys(markerMap).forEach((id) => {
      markerMap[id].setPopupContent(buildPopupHtml(memoryMap[id]));
    });
  }

  async function deleteById(id) {
    if (!UI.isEditingEnabled()) return;
    if (!confirm("Delete this memory?")) return;

    try {
      await Storage.remove(id);
    } catch (error) {
      showToast(error.message || "Could not delete memory.", "error");
      return;
    }
    removeMarker(id);
    Gallery.removeCard(id);
    UI.updateCount();
    MapModule.getMap().closePopup();
  }

  function updateMarker(memory) {
    memoryMap[memory.id] = memory;
    if (markerMap[memory.id]) {
      markerMap[memory.id].setIcon(createIcon(memory));
      markerMap[memory.id].setTooltipContent(markerCaption(memory));
      markerMap[memory.id].setPopupContent(buildPopupHtml(memory));
    }
  }

  return { init, addMarker, addMarkers, deleteById, refreshPopups, removeMarker, updateMarker };
})();

const UploadModal = (() => {
  let pendingLatLng = null;
  let pendingImageDataURLs = [];
  let fileSelectionId = 0;

  const overlay = document.getElementById("upload-modal");
  const zone = document.getElementById("upload-zone");
  const fileInput = document.getElementById("file-input");
  const preview = document.getElementById("upload-preview");
  const selection = document.getElementById("upload-selection");
  const caption = document.getElementById("input-caption");
  const dateInput = document.getElementById("input-date");
  const category = document.getElementById("input-category");
  const saveBtn = document.getElementById("upload-save");
  const locLabel = document.getElementById("upload-location-label");

  function open(latlng) {
    pendingLatLng = latlng;
    pendingImageDataURLs = [];
    preview.src = "";
    preview.classList.remove("visible");
    selection.textContent = "";
    selection.classList.remove("visible");
    caption.value = "";
    dateInput.value = new Date().toISOString().slice(0, 10);
    category.value = "travel";
    saveBtn.disabled = true;
    saveBtn.textContent = "Save Memory";

    resetZone();
    locLabel.textContent = `Loading ${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)}...`;
    fetchPlaceName(latlng.lat, latlng.lng).then((name) => {
      locLabel.textContent = name;
    });

    if (!overlay.open) overlay.showModal();
  }

  function close() {
    if (overlay.open) overlay.close();
  }

  // Runs for every way the dialog can close (buttons, Esc, backdrop, back gesture)
  overlay.addEventListener("close", () => {
    pendingLatLng = null;
    pendingImageDataURLs = [];
    fileSelectionId += 1;
    resetZone();
  });

  function resetZone() {
    zone.style.display = "";
    preview.classList.remove("visible");
    selection.classList.remove("visible");
    selection.textContent = "";
    fileInput.value = "";
  }

  async function fetchPlaceName(lat, lng) {
    try {
      const response = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`,
        {
          headers: { "Accept-Language": "en" },
        },
      );
      const data = await response.json();
      const address = data.address || {};
      return (
        [
          address.city || address.town || address.village || address.county,
          address.country,
        ]
          .filter(Boolean)
          .join(", ") || `${lat.toFixed(4)}, ${lng.toFixed(4)}`
      );
    } catch {
      return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    }
  }

  function compressImage(file, maxDim = 1600, quality = 0.82) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
          let { width, height } = img;
          const scale = Math.min(1, maxDim / Math.max(width, height));
          width = Math.round(width * scale);
          height = Math.round(height * scale);

          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          canvas.getContext("2d").drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL("image/jpeg", quality));
        };
        img.onerror = reject;
        img.src = event.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function makeThumbnail(dataURL) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const size = 120;
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        canvas.width = size;
        canvas.height = size;

        const scale = size / Math.min(img.width, img.height);
        const sw = size / scale;
        const sh = size / scale;
        const sx = (img.width - sw) / 2;
        const sy = (img.height - sh) / 2;

        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, size, size);
        resolve(canvas.toDataURL("image/jpeg", 0.72));
      };
      img.src = dataURL;
    });
  }

  function dataURLToFile(dataURL, filename) {
    const [meta, base64] = dataURL.split(",");
    const mimeMatch = meta.match(/data:(.*?);base64/);
    const mimeType = mimeMatch ? mimeMatch[1] : "image/jpeg";
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return new File([bytes], filename, { type: mimeType });
  }

  async function handleFiles(files) {
    const selectionId = (fileSelectionId += 1);
    const validFiles = Array.from(files || []).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (!validFiles.length) return;

    const oversized = validFiles.find((file) => file.size > 8 * 1024 * 1024);
    if (oversized) {
      showToast(`"${oversized.name}" is too large (max 8 MB).`, "error");
      return;
    }

    saveBtn.disabled = true;
    selection.textContent = `Preparing 0 / ${validFiles.length} images...`;
    selection.classList.add("visible");

    const compressed = [];
    try {
      for (let index = 0; index < validFiles.length; index += 1) {
        const imageDataURL = await compressImage(validFiles[index]);
        if (selectionId !== fileSelectionId) return;
        compressed.push(imageDataURL);
        selection.textContent = `Preparing ${index + 1} / ${validFiles.length} images...`;
        await yieldToBrowser();
      }
    } catch {
      if (selectionId === fileSelectionId) {
        showToast("Could not process the selected images.", "error");
        resetZone();
        saveBtn.disabled = true;
      }
      return;
    }

    pendingImageDataURLs = compressed;

    preview.src = compressed[0];
    preview.classList.add("visible");
    selection.textContent =
      compressed.length === 1
        ? "1 image selected."
        : `${compressed.length} images selected. The first image is shown as preview.`;
    selection.classList.add("visible");
    // The zone is about to be hidden: move keyboard focus to the next useful control instead of dropping it
    const zoneHadFocus = zone.contains(document.activeElement);
    zone.style.display = "none";
    saveBtn.disabled = false;
    saveBtn.textContent =
      compressed.length > 1
        ? `Save Memory · ${compressed.length} photos`
        : "Save Memory";
    if (zoneHadFocus) saveBtn.focus();
  }

  zone.addEventListener("click", () => fileInput.click());
  zone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener("change", (event) =>
    handleFiles(event.target.files),
  );

  zone.addEventListener("dragover", (event) => {
    event.preventDefault();
    zone.classList.add("dragover");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
  zone.addEventListener("drop", (event) => {
    event.preventDefault();
    zone.classList.remove("dragover");
    handleFiles(event.dataTransfer.files);
  });

  document.getElementById("upload-close").addEventListener("click", close);
  document.getElementById("upload-cancel").addEventListener("click", close);

  saveBtn.addEventListener("click", async () => {
    if (!pendingImageDataURLs.length || !pendingLatLng) return;

    saveBtn.disabled = true;
    saveBtn.textContent = "Saving...";

    try {
      const baseCaption = caption.value.trim();
      const baseCreatedAt = Date.now();

      const imagesToUpload = [];
      for (let index = 0; index < pendingImageDataURLs.length; index += 1) {
        saveBtn.textContent =
          pendingImageDataURLs.length > 1
            ? `Preparing ${index + 1} / ${pendingImageDataURLs.length}...`
            : "Preparing...";
        const imageDataURL = pendingImageDataURLs[index];
        const thumbnailDataURL = await makeThumbnail(imageDataURL);
        imagesToUpload.push({
          imageFile: dataURLToFile(imageDataURL, `memory-${index + 1}.jpg`),
          thumbnailFile: dataURLToFile(thumbnailDataURL, `thumb-${index + 1}.jpg`),
        });
        await yieldToBrowser();
      }

      saveBtn.textContent = "Uploading...";
      const memory = await Storage.create({
        images: imagesToUpload,
        caption: baseCaption,
        date: dateInput.value,
        category: category.value,
        lat: pendingLatLng.lat,
        lng: pendingLatLng.lng,
        createdAt: baseCreatedAt,
      });

      Markers.addMarker(memory, MapModule.getMap());
      Gallery.addCard(memory);

      UI.updateCount();
      close();
      showToast("Memory saved!");
    } catch (error) {
      showToast(error.message || "Could not save memory.", "error");
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save Memory";
    }
  });

  closeOnBackdropPress(overlay);

  return { open, close, compressImage, makeThumbnail, dataURLToFile };
})();

const PasscodeModal = (() => {
  const overlay = document.getElementById("passcode-modal");
  const form = document.getElementById("passcode-form");
  const input = document.getElementById("passcode-input");
  const error = document.getElementById("passcode-error");
  const submitBtn = document.getElementById("passcode-submit");
  const closeBtn = document.getElementById("passcode-close");
  const cancelBtn = document.getElementById("passcode-cancel");

  let submitHandler = null;

  function reset() {
    form.reset();
    error.textContent = "";
    error.classList.remove("visible");
    submitBtn.disabled = false;
    submitBtn.textContent = "Unlock";
  }

  function open(onSubmit) {
    submitHandler = onSubmit;
    reset();
    if (!overlay.open) overlay.showModal(); // the input has `autofocus`
  }

  function close() {
    if (overlay.open) overlay.close();
  }

  overlay.addEventListener("close", () => {
    submitHandler = null;
  });

  function showError(message) {
    error.textContent = message;
    error.classList.add("visible");
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!submitHandler) return;

    const passcode = input.value.trim();
    if (!passcode) {
      showError("Enter your passcode.");
      return;
    }

    error.textContent = "";
    error.classList.remove("visible");
    submitBtn.disabled = true;
    submitBtn.textContent = "Unlocking...";

    try {
      await submitHandler(passcode);
      close();
    } catch (errorValue) {
      showError(errorValue.message || "Could not unlock owner mode.");
      submitBtn.disabled = false;
      submitBtn.textContent = "Unlock";
    }
  }

  function handleDismiss() {
    close();
  }

  form.addEventListener("submit", handleSubmit);
  closeBtn.addEventListener("click", handleDismiss);
  cancelBtn.addEventListener("click", handleDismiss);
  closeOnBackdropPress(overlay);

  return { open, close };
})();

const ViewModal = (() => {
  const overlay = document.getElementById("view-modal");
  const image = document.getElementById("view-image");
  const prevBtn = document.getElementById("view-prev");
  const nextBtn = document.getElementById("view-next");
  const counter = document.getElementById("view-counter");
  const badge = document.getElementById("view-badge");
  const caption = document.getElementById("view-caption");
  const meta = document.getElementById("view-meta");
  const coords = document.getElementById("view-coords");
  const deleteBtn = document.getElementById("view-delete");
  const editBtn = document.getElementById("view-edit");

  const CATEGORY_LABEL = {
    travel: "Travel",
    food: "Food",
    friends: "Friends",
    nature: "Nature",
    culture: "Culture",
  };

  let currentId = null;
  let currentMemory = null;
  let imageIndex = 0;

  function renderImage() {
    if (!currentMemory || !currentMemory.images || currentMemory.images.length === 0) return;
    image.src = currentMemory.images[imageIndex].image;
    
    if (currentMemory.images.length > 1) {
      prevBtn.style.display = "flex";
      nextBtn.style.display = "flex";
      counter.style.display = "block";
      counter.textContent = `${imageIndex + 1} / ${currentMemory.images.length}`;
    } else {
      prevBtn.style.display = "none";
      nextBtn.style.display = "none";
      counter.style.display = "none";
    }
  }

  function step(delta) {
    const total = currentMemory && currentMemory.images ? currentMemory.images.length : 0;
    if (total < 2) return;
    imageIndex = (imageIndex + delta + total) % total;
    renderImage();
  }

  prevBtn.addEventListener("click", () => step(-1));
  nextBtn.addEventListener("click", () => step(1));

  overlay.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft") step(-1);
    if (event.key === "ArrowRight") step(1);
  });

  // Swipe left/right on the photo (the wrapper has touch-action: pan-y)
  const imageWrap = overlay.querySelector(".view-image-wrap");
  let swipeStart = null;
  imageWrap.addEventListener("pointerdown", (event) => {
    swipeStart = { x: event.clientX, y: event.clientY };
  });
  imageWrap.addEventListener("pointerup", (event) => {
    if (!swipeStart) return;
    const dx = event.clientX - swipeStart.x;
    const dy = event.clientY - swipeStart.y;
    swipeStart = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
  });
  imageWrap.addEventListener("pointercancel", () => {
    swipeStart = null;
  });

  async function open(id) {
    const memory = await Storage.getById(id);
    if (!memory) return;

    currentId = id;
    currentMemory = memory;
    imageIndex = 0;

    renderImage();
    image.alt = memory.caption
      ? `Photo from ${memory.caption}`
      : "Travel memory photo";
    badge.textContent =
      CATEGORY_LABEL[memory.category] || memory.category || "Memory";
    caption.textContent = memory.caption || "Untitled memory";
    meta.textContent = memory.date
      ? new Date(memory.date).toLocaleDateString("en-GB", {
          day: "numeric",
          month: "long",
          year: "numeric",
        })
      : "";
    coords.textContent = `${memory.lat.toFixed(5)}°, ${memory.lng.toFixed(5)}°`;
    syncControls();

    if (!overlay.open) overlay.showModal();
    MapModule.getMap().closePopup();
  }

  function close() {
    if (overlay.open) overlay.close();
  }

  overlay.addEventListener("close", () => {
    currentId = null;
  });

  function syncControls() {
    deleteBtn.style.display = UI.isEditingEnabled() ? "" : "none";
    editBtn.style.display = UI.isEditingEnabled() ? "" : "none";
  }

  editBtn.addEventListener("click", () => {
    if (!currentId || !UI.isEditingEnabled()) return;
    EditModal.open(currentId);
    close();
  });

  deleteBtn.addEventListener("click", async () => {
    if (!currentId || !UI.isEditingEnabled()) return;
    if (!confirm("Delete this memory?")) return;

    deleteBtn.disabled = true;
    deleteBtn.textContent = "Deleting...";
    try {
      await Storage.remove(currentId);
      Markers.removeMarker(currentId);
      Gallery.removeCard(currentId);
      UI.updateCount();
      close();
      showToast("Memory deleted.");
    } catch (error) {
      showToast(error.message || "Could not delete memory.", "error");
    } finally {
      deleteBtn.disabled = false;
      deleteBtn.textContent = "Delete";
    }
  });

  document.getElementById("view-close").addEventListener("click", close);
  document.getElementById("view-close2").addEventListener("click", close);
  closeOnBackdropPress(overlay);

  return { open, close, syncControls };
})();

const EditModal = (() => {
  const overlay = document.getElementById("edit-modal");
  const closeBtn = document.getElementById("edit-close");
  const cancelBtn = document.getElementById("edit-cancel");
  const saveBtn = document.getElementById("edit-save");
  const captionInput = document.getElementById("edit-input-caption");
  const dateInput = document.getElementById("edit-input-date");
  const categoryInput = document.getElementById("edit-input-category");
  const locLabel = document.getElementById("edit-location-label");
  const imagesGrid = document.getElementById("edit-images-grid");
  const addBtn = document.getElementById("edit-images-add");
  const fileInput = document.getElementById("edit-file-input");

  let currentId = null;
  let keptImages = [];
  let pendingNewImageDataURLs = [];

  function renderImages() {
    imagesGrid.innerHTML = "";
    
    keptImages.forEach((img, i) => {
      const div = document.createElement("div");
      div.className = "edit-image-item";
      div.innerHTML = `<img src="${img.thumbnail}" alt="Photo ${i + 1}" /><button type="button" class="edit-image-remove" data-type="kept" data-index="${i}" aria-label="Remove photo ${i + 1}">✕</button>`;
      imagesGrid.appendChild(div);
    });

    pendingNewImageDataURLs.forEach((dataUrl, i) => {
      const div = document.createElement("div");
      div.className = "edit-image-item pending";
      div.innerHTML = `<img src="${dataUrl}" alt="New photo ${i + 1}" /><button type="button" class="edit-image-remove" data-type="new" data-index="${i}" aria-label="Remove new photo ${i + 1}">✕</button>`;
      imagesGrid.appendChild(div);
    });

    imagesGrid.querySelectorAll(".edit-image-remove").forEach(btn => {
      btn.addEventListener("click", (e) => {
        const type = e.currentTarget.dataset.type;
        const index = parseInt(e.currentTarget.dataset.index, 10);
        if (type === "kept") keptImages.splice(index, 1);
        if (type === "new") pendingNewImageDataURLs.splice(index, 1);
        renderImages();
      });
    });
  }

  addBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async (event) => {
    const files = Array.from(event.target.files || []).filter(f => f.type.startsWith("image/"));
    for (const file of files) {
      if (file.size > 8 * 1024 * 1024) { showToast(`"${file.name}" is too large (max 8 MB).`, "error"); continue; }
      try {
        const compressed = await UploadModal.compressImage(file);
        pendingNewImageDataURLs.push(compressed);
      } catch {
        showToast(`Could not process "${file.name}".`, "error");
      }
      await yieldToBrowser();
    }
    fileInput.value = "";
    renderImages();
  });

  async function open(id) {
    const memory = await Storage.getById(id);
    if (!memory) return;

    currentId = id;
    keptImages = [...(memory.images || [])];
    pendingNewImageDataURLs = [];
    renderImages();

    captionInput.value = memory.caption || "";
    dateInput.value = memory.date || "";
    categoryInput.value = memory.category || "travel";
    locLabel.textContent = `${memory.lat.toFixed(5)}°, ${memory.lng.toFixed(5)}°`;

    saveBtn.disabled = false;
    saveBtn.textContent = "Save Changes";

    if (!overlay.open) overlay.showModal();
  }

  function close() {
    if (overlay.open) overlay.close();
  }

  overlay.addEventListener("close", () => {
    currentId = null;
  });

  saveBtn.addEventListener("click", async () => {
    if (!currentId) return;

    if (keptImages.length === 0 && pendingNewImageDataURLs.length === 0) {
      showToast("A memory must have at least one image.", "error");
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = "Saving...";

    try {
      const newImages = [];
      for (let i = 0; i < pendingNewImageDataURLs.length; i++) {
        saveBtn.textContent =
          pendingNewImageDataURLs.length > 1
            ? `Preparing ${i + 1} / ${pendingNewImageDataURLs.length}...`
            : "Preparing...";
        const dataUrl = pendingNewImageDataURLs[i];
        const thumbUrl = await UploadModal.makeThumbnail(dataUrl);
        newImages.push({
          imageFile: UploadModal.dataURLToFile(dataUrl, `new-${i}.jpg`),
          thumbnailFile: UploadModal.dataURLToFile(thumbUrl, `new-thumb-${i}.jpg`)
        });
        await yieldToBrowser();
      }

      saveBtn.textContent = "Uploading...";
      const updatedMemory = await Storage.update(currentId, {
        caption: captionInput.value.trim(),
        date: dateInput.value,
        category: categoryInput.value,
        keptImages: keptImages.map(img => ({ imageKey: img.imageKey, thumbnailKey: img.thumbnailKey })),
        newImages: newImages
      });

      Gallery.updateCard(updatedMemory);
      Markers.updateMarker(updatedMemory);
      
      close();
      showToast("Memory updated.");
      ViewModal.open(updatedMemory.id);
    } catch (error) {
      showToast(error.message || "Could not update memory.", "error");
      saveBtn.disabled = false;
      saveBtn.textContent = "Save Changes";
    }
  });

  closeBtn.addEventListener("click", close);
  cancelBtn.addEventListener("click", close);
  closeOnBackdropPress(overlay);

  return { open, close };
})();

const Gallery = (() => {
  const panel = document.getElementById("gallery-panel");
  const grid = document.getElementById("gallery-grid");
  const emptyMsg = document.getElementById("gallery-empty");
  const filterBtns = document.querySelectorAll(".filter-btn");

  let activeFilter = "all";

  function coverImage(memory) {
    const firstImage = memory.images && memory.images.length ? memory.images[0] : null;
    return (firstImage && (firstImage.image || firstImage.thumbnail)) || memory.image || memory.thumbnail || "";
  }

  function open() {
    panel.inert = false;
    panel.classList.add("open");
    panel.setAttribute("aria-hidden", "false");
    document.getElementById("btn-gallery").classList.add("active");
    document.getElementById("btn-gallery").setAttribute("aria-expanded", "true");
    document.getElementById("gallery-close").focus({ preventScroll: true });
  }

  function close() {
    // Hand focus back to the toggle before the panel becomes inert, otherwise it is dropped to <body>
    if (panel.contains(document.activeElement)) document.getElementById("btn-gallery").focus();
    panel.classList.remove("open");
    panel.setAttribute("aria-hidden", "true");
    panel.inert = true;
    document.getElementById("btn-gallery").classList.remove("active");
    document.getElementById("btn-gallery").setAttribute("aria-expanded", "false");
  }

  function toggle() {
    if (panel.classList.contains("open")) {
      close();
      return;
    }
    open();
  }

  function createCard(memory) {
    const date = memory.date
      ? new Date(memory.date).toLocaleDateString("en-GB", {
          day: "numeric",
          month: "short",
          year: "numeric",
        })
      : "";
    const imageSrc = coverImage(memory);

    const card = document.createElement("button");
    card.type = "button";
    card.className = "gallery-card";
    card.dataset.id = memory.id;
    card.dataset.cat = memory.category;
    card.innerHTML = `
      <img src="${escHtml(imageSrc)}" alt="${escHtml(memory.caption || "Travel memory")}" loading="lazy" />
      <div class="gallery-card-info">
        <div class="gallery-card-caption">${escHtml(memory.caption || "Untitled memory")}</div>
        ${date ? `<div class="gallery-card-date">${date}</div>` : ""}
      </div>`;

    card.addEventListener("click", () => {
      close();
      MapModule.flyTo(memory.lat, memory.lng, 10);
      setTimeout(() => ViewModal.open(memory.id), 900);
    });

    return card;
  }

  function addCard(memory, prepend = true) {
    const card = createCard(memory);

    if (prepend && grid.firstChild) {
      grid.insertBefore(card, grid.firstChild);
    } else {
      grid.appendChild(card);
    }

    applyFilter(activeFilter);
    updateEmpty();
  }

  function render(memories) {
    const fragment = document.createDocumentFragment();
    memories.forEach((memory) => {
      fragment.appendChild(createCard(memory));
    });

    grid.textContent = "";
    grid.appendChild(fragment);
    applyFilter(activeFilter);
  }

  function removeCard(id) {
    const card = grid.querySelector(`[data-id="${id}"]`);
    if (card) {
      card.remove();
    }
    updateEmpty();
  }

  function updateCard(memory) {
    const card = grid.querySelector(`[data-id="${memory.id}"]`);
    if (!card) return;

    card.dataset.cat = memory.category;
    
    const date = memory.date
      ? new Date(memory.date).toLocaleDateString("en-GB", {
          day: "numeric",
          month: "short",
          year: "numeric",
        })
      : "";
    const imageSrc = coverImage(memory);

    card.innerHTML = `
      <img src="${escHtml(imageSrc)}" alt="${escHtml(memory.caption || "Travel memory")}" loading="lazy" />
      <div class="gallery-card-info">
        <div class="gallery-card-caption">${escHtml(memory.caption || "Untitled memory")}</div>
        ${date ? `<div class="gallery-card-date">${date}</div>` : ""}
      </div>`;

    applyFilter(activeFilter);
  }

  function applyFilter(category) {
    activeFilter = category;
    filterBtns.forEach((btn) => {
      const isActive = btn.dataset.cat === category;
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-pressed", String(isActive));
    });

    grid.querySelectorAll(".gallery-card").forEach((card) => {
      card.style.display =
        category === "all" || card.dataset.cat === category ? "" : "none";
    });

    updateEmpty();
  }

  function updateEmpty() {
    const visibleCards = [...grid.querySelectorAll(".gallery-card")].filter(
      (card) => card.style.display !== "none",
    );
    // Only the owner can add memories, so only the owner is told to click the map
    emptyMsg.textContent =
      activeFilter !== "all"
        ? "No memories in this category yet."
        : UI.isEditingEnabled()
          ? "No memories yet. Click on the map to add your first one."
          : "No memories yet.";
    emptyMsg.classList.toggle("visible", visibleCards.length === 0);
  }

  filterBtns.forEach((btn) => {
    btn.addEventListener("click", () => applyFilter(btn.dataset.cat));
  });

  document.getElementById("gallery-close").addEventListener("click", close);

  return { open, close, toggle, addCard, removeCard, render, updateCard, updateEmpty };
})();

const UI = (() => {
  const hint = document.getElementById("map-hint");
  const hintText = document.getElementById("map-hint-text");
  const editBtn = document.getElementById("btn-edit-mode");
  const editLabel = document.getElementById("edit-mode-label");
  let hintDismissed = false;
  let editingEnabled = false;

  function init() {
    document.getElementById("btn-world").addEventListener("click", () => {
      MapModule.flyToEurope();
      setActive("btn-world");
    });

    document.getElementById("btn-vietnam").addEventListener("click", () => {
      MapModule.flyToVietnam();
      setActive("btn-vietnam");
    });

    document.getElementById("btn-gallery").addEventListener("click", () => {
      Gallery.toggle();
    });

    editBtn.addEventListener("click", () => {
      if (editingEnabled) {
        lockOwnerMode();
        return;
      }

      PasscodeModal.open(async (passcode) => {
        await Storage.verifyOwnerPasscode(passcode);
        setEditingEnabled(true);
      });
    });

    const map = MapModule.getMap();
    setActive("btn-vietnam");
    setEditingEnabled(Storage.isOwnerSessionUnlocked());

    // Small screens: the intro card covers part of the map, so fade it out once the user starts panning
    map.once("dragstart", () => document.body.classList.add("story-dismissed"));

    // HUD readout: cursor position on hover devices, map centre on touch devices, plus zoom level
    const hudLat = document.getElementById("hud-lat");
    const hudLng = document.getElementById("hud-lng");
    const hudZoom = document.getElementById("hud-zoom");
    const showCoords = (latlng) => {
      hudLat.textContent = latlng.lat.toFixed(4);
      hudLng.textContent = latlng.lng.toFixed(4);
    };
    showCoords(map.getCenter());
    hudZoom.textContent = map.getZoom();
    if (window.matchMedia("(hover: hover)").matches) {
      map.on("mousemove", (event) => showCoords(event.latlng));
    } else {
      map.on("move", () => showCoords(map.getCenter()));
    }
    map.on("zoomend", () => {
      hudZoom.textContent = map.getZoom();
    });

    map.on("click", (event) => {
      if (!editingEnabled) return;

      if (!hintDismissed) {
        hintDismissed = true;
        hint.classList.add("hidden");
      }

      UploadModal.open(event.latlng);
    });

    map.on("zoomend", () => {
      const zoom = map.getZoom();
      const center = map.getCenter();
      const inVietnam =
        center.lat > 8 &&
        center.lat < 24 &&
        center.lng > 102 &&
        center.lng < 110;
      const inEurope =
        center.lat > 35 &&
        center.lat < 71 &&
        center.lng > -25 &&
        center.lng < 40;

      // if (inVietnam && zoom >= 5) {
      //   cityPills.classList.add("visible");
      //   euPills.classList.remove("visible");
      //   setActive("btn-vietnam");
      // } else if (inEurope && zoom >= 4) {
      //   euPills.classList.add("visible");
      //   cityPills.classList.remove("visible");
      //   setActive("btn-world");
      // } else if (zoom < 3) {
      //   cityPills.classList.remove("visible");
      //   euPills.classList.remove("visible");
      // }
    });
  }

  function setActive(id) {
    document
      .querySelectorAll(".nav-btn:not(.nav-btn-edit)")
      .forEach((btn) => btn.classList.remove("active"));
    const target = document.getElementById(id);
    if (target) {
      target.classList.add("active");
    }

    ["btn-vietnam", "btn-world"].forEach((buttonId) => {
      document
        .getElementById(buttonId)
        .setAttribute("aria-pressed", String(buttonId === id));
    });

    const regionLabel = document.getElementById("active-region-label");
    if (id === "btn-vietnam") regionLabel.textContent = "Việt Nam";
    if (id === "btn-world") regionLabel.textContent = "Europe";
  }

  async function updateCount(count) {
    let nextCount = count;

    if (typeof nextCount !== "number") {
      const cachedCount = Storage.getCachedCount();
      nextCount =
        typeof cachedCount === "number" ? cachedCount : (await Storage.getAll()).length;
    }

    document.getElementById("memory-count").textContent = nextCount;
  }

  function setEditingEnabled(enabled) {
    editingEnabled = enabled;
    hintText.textContent = enabled
      ? "Click anywhere on the map to drop a memory"
      : "Select a marker to revisit a memory";
    hint.classList.toggle("hidden", enabled && hintDismissed);
    editLabel.textContent = enabled
      ? "Editing on"
      : "Owner mode";
    editBtn.classList.toggle("active", enabled);
    editBtn.classList.toggle("off", !enabled);
    editBtn.setAttribute("aria-pressed", String(enabled));
    editBtn.title = enabled ? "Lock owner mode" : "Unlock owner mode";
    document.body.classList.toggle("editing-disabled", !enabled);

    if (!enabled) {
      UploadModal.close();
      MapModule.getMap().closePopup();
    }

    Markers.refreshPopups();
    ViewModal.syncControls();
    Gallery.updateEmpty();
  }

  function lockOwnerMode() {
    Storage.clearOwnerPasscode();
    setEditingEnabled(false);
  }

  function isEditingEnabled() {
    return editingEnabled;
  }

  return { init, isEditingEnabled, updateCount };
})();

function escHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Close a modal <dialog> when the press AND release both land on its backdrop.
// A click-target check would also fire for the dialog's own padding, so test the pointer position instead.
function closeOnBackdropPress(dialog) {
  const outside = (event) => {
    const rect = dialog.getBoundingClientRect();
    return (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    );
  };
  let pressedOutside = false;
  dialog.addEventListener("pointerdown", (event) => {
    pressedOutside = outside(event);
  });
  dialog.addEventListener("pointerup", (event) => {
    if (pressedOutside && outside(event)) dialog.close();
    pressedOutside = false;
  });
}

let toastTimer = null;
function showToast(message, type = "info") {
  const el = document.getElementById("toast");
  // An open modal <dialog> makes the rest of the page inert (hidden from screen readers), so host the toast inside it.
  const host = document.querySelector("dialog[open]") || document.body;
  if (el.parentElement !== host) host.appendChild(el);
  el.setAttribute("role", type === "error" ? "alert" : "status");
  // The toast is a manual popover (top layer). Re-show it so it stacks above any <dialog> opened since the last toast.
  if (el.showPopover) {
    if (el.matches(":popover-open")) el.hidePopover();
    el.showPopover();
  }
  el.textContent = message;
  el.classList.toggle("toast-error", type === "error");
  el.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("visible"), type === "error" ? 5000 : 2500);
}

function yieldToBrowser() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
      return;
    }

    setTimeout(resolve, 0);
  });
}

async function boot() {
  const memoriesPromise = Storage.getAll(true);
  const map = await MapModule.init();
  Markers.init(map);
  UI.init();

  // Open <dialog>s close themselves on Esc; only close the gallery panel when no dialog is open
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !document.querySelector("dialog[open]")) {
      Gallery.close();
    }
  });

  try {
    const memories = await memoriesPromise;
    memories.sort((left, right) => left.createdAt - right.createdAt);

    Markers.addMarkers(memories);
    Gallery.render(memories);
    UI.updateCount(memories.length);
  } catch (error) {
    console.warn("Could not load memories:", error);
    showToast("Couldn't load memories. Check your connection and reload the page.", "error");
  }

  const loading = document.getElementById("loading-overlay");
  loading.classList.add("hidden");
  setTimeout(() => loading.remove(), 600);
}

document.addEventListener("DOMContentLoaded", boot);
