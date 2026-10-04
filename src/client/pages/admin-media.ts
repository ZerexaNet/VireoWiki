// @ts-nocheck — admin-media.html 인라인 스크립트 이관(동작 보존). common.ts 와 동일 사유로 타입검사 비활성.
//
// 이관 규칙:
//  - common.ts 가 window.* 로 노출하는 공통 전역(loadConfig / currentUser /
//    escapeHtml / mountMediaTagInput)은 모듈 스코프에서 bare 식별자로 해석되지
//    않으므로 모두 window.* 로 접근한다.
//  - CDN 전역(Swal)은 그대로 둔다.
//  - HTML 의 onclick / onchange 속성(정적 HTML + innerHTML 생성 문자열 양쪽)에서
//    호출되는 함수는 파일 끝에서 window.* 로 노출한다.
//    (runGarbageCollector / gcSelectAll / gcDeselectAll / gcDeleteSelected /
//     changeMediaSort / searchMedia / goToMediaPage / trackBacklinks / deleteMedia)

import { ui, getLocale } from '../../../packages/wiki-shared/src/i18n/client';
document.addEventListener("DOMContentLoaded", async () => {
  await window.loadConfig();
  try {
    const res = await fetch("/api/me");
    if (!res.ok) throw new Error();
    window.currentUser = await res.json();

    if (
      window.currentUser.role !== "admin" &&
      window.currentUser.role !== "super_admin"
    ) {
      Swal.fire(
        ui("m_d6f5e3691cc6008b"),
        ui("m_25044a9beab77aac"),
        "error",
      ).then(() => {
        window.location.href = "/";
      });
      return;
    }

    // 쓰레기 수집기(미사용 이미지 일괄 삭제)는 최고 관리자 전용 — 서버에서도 '*' 게이팅됨.
    if (window.currentUser.role === "super_admin") {
      const gcCard = document.getElementById("gcCard");
      if (gcCard) gcCard.style.display = "";
    }

    document
      .querySelectorAll("#userAvatar")
      .forEach((el) => (el.src = window.currentUser.picture || ""));
    document
      .querySelectorAll("#userName")
      .forEach((el) => (el.textContent = window.currentUser.name));

    mediaTagWidget = window.mountMediaTagInput({
      container: document.getElementById("mediaTagContainer"),
      input: document.getElementById("mediaTagInput"),
      initial: [],
    });
    mediaTagWidget.setOnChange(() => {
      mediaTagFilter = mediaTagWidget.getTags();
      loadMedia(1);
    });

    loadMedia();
  } catch (e) {
    window.location.href = "/login";
  }
});

// ── 이미지(미디어) 관리 ──
var mediaPage = 1;
var mediaPageSize = 10;
var mediaSearch = "";
var mediaSort = "date_desc";
var mediaTotal = 0;
var mediaItems = [];
var mediaTagFilter = [];
var mediaTagWidget = null;

async function loadMedia(page = 1) {
  try {
    mediaPage = Math.max(1, page);
    const offset = (mediaPage - 1) * mediaPageSize;

    const params = new URLSearchParams({
      limit: mediaPageSize,
      offset: offset,
      sort: mediaSort,
    });
    if (mediaSearch) params.append("search", mediaSearch);
    if (mediaTagFilter && mediaTagFilter.length > 0) {
      params.append("tags", mediaTagFilter.join(","));
    }

    document.getElementById("mediaList").innerHTML = window.uiSkeletonCards(6);

    const res = await fetch(`/api/admin/media?${params.toString()}`);
    if (!res.ok) throw new Error(ui("m_290aea65c3f16fa7"));
    const data = await res.json();

    mediaTotal = data.total;
    mediaItems = data.media || [];

    const totalPages = Math.max(1, Math.ceil(mediaTotal / mediaPageSize));
    if (mediaPage > totalPages && mediaTotal > 0) {
      return loadMedia(totalPages);
    }

    renderMedia();
  } catch (err) {
    document.getElementById("mediaList").innerHTML =
      window.uiEmptyState({ icon: 'bi bi-exclamation-triangle', title: ui("m_83382c601afc0ed6") });
    document.getElementById("mediaPagination").innerHTML = "";
    document.getElementById("mediaTotalInfo").textContent = "";
  }
}

function searchMedia() {
  mediaSearch = document.getElementById("mediaSearchInput").value.trim();
  loadMedia(1);
}

function changeMediaSort() {
  mediaSort = document.getElementById("mediaSortSelect").value;
  loadMedia(1);
}

document
  .getElementById("mediaSearchInput")
  .addEventListener("keypress", (e) => {
    if (e.key === "Enter") searchMedia();
  });

function goToMediaPage(page) {
  const totalPages = Math.max(1, Math.ceil(mediaTotal / mediaPageSize));
  const target = Math.min(Math.max(1, page), totalPages);
  if (target === mediaPage) return;
  loadMedia(target);
  document
    .getElementById("mediaList")
    .scrollIntoView({ behavior: "smooth", block: "start" });
}

function getMediaPageNumbers(current, total) {
  const pages = [];
  if (total <= 7) {
    for (let i = 1; i <= total; i++) pages.push(i);
    return pages;
  }
  pages.push(1);
  if (current > 3) pages.push("...");
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  for (let i = start; i <= end; i++) pages.push(i);
  if (current < total - 2) pages.push("...");
  pages.push(total);
  return pages;
}

function renderMediaPagination() {
  const container = document.getElementById("mediaPagination");
  if (mediaTotal === 0) {
    container.innerHTML = "";
    return;
  }
  const totalPages = Math.max(1, Math.ceil(mediaTotal / mediaPageSize));
  const pages = getMediaPageNumbers(mediaPage, totalPages);
  const isFirst = mediaPage === 1;
  const isLast = mediaPage === totalPages;

  let html =
    '<ul class="pagination pagination-sm justify-content-center mb-0 flex-wrap">';
  html += ui("m_e6c8a4e6ff6206e1", [isFirst ? "disabled" : "", isFirst ? "disabled" : ""]);
  html += ui("m_56faeea9d4279b1a", [isFirst ? "disabled" : "", mediaPage - 1, isFirst ? "disabled" : ""]);
  for (const p of pages) {
    if (p === "...") {
      html +=
        '<li class="page-item disabled"><span class="page-link">…</span></li>';
    } else {
      const active = p === mediaPage ? "active" : "";
      html += `<li class="page-item ${active}"><button type="button" class="page-link" onclick="goToMediaPage(${p})">${p}</button></li>`;
    }
  }
  html += ui("m_1ebf863315a6276d", [isLast ? "disabled" : "", mediaPage + 1, isLast ? "disabled" : ""]);
  html += ui("m_18abceefc15fa773", [isLast ? "disabled" : "", totalPages, isLast ? "disabled" : ""]);
  html += "</ul>";
  container.innerHTML = html;
}

function renderMedia() {
  const listEl = document.getElementById("mediaList");
  const totalInfo = document.getElementById("mediaTotalInfo");

  if (!mediaItems || mediaItems.length === 0) {
    listEl.innerHTML = window.uiEmptyState({ icon: 'bi bi-images', title: ui("m_4e35e2915449a848") });
    document.getElementById("mediaPagination").innerHTML = "";
    totalInfo.textContent = "";
    return;
  }

  listEl.innerHTML = mediaItems
    .map((m) => {
      const isVideo = m.mime_type && m.mime_type.startsWith("video/");
      const publicUrl = m.r2_key ? window.escapeHtml(`/media/${m.r2_key}`) : "";
      const preview = isVideo
        ? `<video src="${publicUrl}" muted></video>`
        : `<img src="${publicUrl}" alt="${window.escapeHtml(m.filename)}" loading="lazy">`;

      const sizeStr =
        m.size < 1024
          ? `${m.size} B`
          : m.size < 1024 * 1024
            ? `${(m.size / 1024).toFixed(1)} KB`
            : `${(m.size / (1024 * 1024)).toFixed(1)} MB`;

      const uploadDate = m.created_at
        ? new Date(m.created_at * 1000).toLocaleString(getLocale())
        : ui("m_1ac13841ba2ea68b");

      const uploaderName = m.uploader_name
        ? window.escapeHtml(m.uploader_name)
        : ui("m_1ac13841ba2ea68b");

      const tagsHtml =
        m.tags && m.tags.length > 0
          ? `<div class="media-item-tags">${m.tags.map((t) => `<span class="media-item-tag">${window.escapeHtml(t)}</span>`).join("")}</div>`
          : "";

      return ui("m_89fa716c20d6975b", [m.id, preview, encodeURIComponent(`이미지:${m.filename}`), window.escapeHtml(m.filename), window.escapeHtml(m.filename), sizeStr, uploadDate, uploaderName, tagsHtml, m.id, window.escapeHtml(m.filename), m.id, window.escapeHtml(m.filename)]);
    })
    .join("");

  const totalPages = Math.max(1, Math.ceil(mediaTotal / mediaPageSize));
  const rangeStart = (mediaPage - 1) * mediaPageSize + 1;
  const rangeEnd = (mediaPage - 1) * mediaPageSize + mediaItems.length;
  totalInfo.textContent = ui("m_02121e9f89592303", [mediaTotal, rangeStart, rangeEnd, mediaPage, totalPages]);

  renderMediaPagination();
}

async function deleteMedia(id, filename) {
  const result = await Swal.fire({
    title: ui("m_4fb0bcdb64aa72c6"),
    text: ui("m_7fe8eb1fe4c3e8b2", [filename]),
    icon: "warning",
    showCancelButton: true,
    confirmButtonText: ui("m_2f9daa828907b93f"),
    cancelButtonText: ui("m_2cd0f3be8738a86c"),
    confirmButtonColor: "#d33",
  });

  if (result.isConfirmed) {
    try {
      const res = await fetch(`/api/admin/media/${id}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || ui("m_c228558cf257fc49"));

      await loadMedia(mediaPage);

      Swal.fire({
        icon: "success",
        title: ui("m_077a6d37719a0e21"),
        toast: true,
        position: "top-end",
        showConfirmButton: false,
        timer: 1500,
      });
    } catch (err) {
      Swal.fire(ui("m_0bc1fb72ae1be5c5"), err.message, "error");
    }
  }
}

// ── 쓰레기 수집기 ──
var gcItems = [];

async function runGarbageCollector() {
  const gcBody = document.getElementById("gcBody");
  const gcStatus = document.getElementById("gcStatus");
  const gcList = document.getElementById("gcList");
  const gcActions = document.getElementById("gcActions");
  const gcRunBtn = document.getElementById("gcRunBtn");

  gcBody.style.display = "block";
  gcActions.style.display = "none";
  gcList.innerHTML = "";
  gcStatus.innerHTML = window.uiInlineLoading({ text: ui("m_74c1a50ecff0bebf") });
  gcRunBtn.disabled = true;

  try {
    const res = await fetch("/api/admin/media/gc");
    if (!res.ok) throw new Error(ui("m_6b5dde6e3a599a71"));
    const data = await res.json();

    gcItems = data.unused || [];

    if (gcItems.length === 0) {
      gcStatus.innerHTML =
        ui("m_ff106bdf32342a01");
      return;
    }

    gcStatus.innerHTML = ui("m_08e1c6d38e3fef61", [data.total_media, data.unused_count]);

    gcList.innerHTML = gcItems
      .map((m) => {
        const isVideo = m.mime_type && m.mime_type.startsWith("video/");
        const publicUrl = m.r2_key ? window.escapeHtml(`/media/${m.r2_key}`) : "";
        const preview = isVideo
          ? `<video src="${publicUrl}" muted style="width:60px;height:60px;object-fit:cover;border-radius:6px;"></video>`
          : `<img src="${publicUrl}" alt="${window.escapeHtml(m.filename)}" loading="lazy" style="width:60px;height:60px;object-fit:cover;border-radius:6px;">`;

        const sizeStr =
          m.size < 1024
            ? `${m.size} B`
            : m.size < 1024 * 1024
              ? `${(m.size / 1024).toFixed(1)} KB`
              : `${(m.size / (1024 * 1024)).toFixed(1)} MB`;

        const uploadDate = m.created_at
          ? new Date(m.created_at * 1000).toLocaleString(getLocale())
          : ui("m_1ac13841ba2ea68b");

        const uploaderName = m.uploader_name
          ? window.escapeHtml(m.uploader_name)
          : ui("m_1ac13841ba2ea68b");

        return ui("m_4fab65f10314a98f", [m.id, preview, encodeURIComponent(`이미지:${m.filename}`), window.escapeHtml(m.filename), window.escapeHtml(m.filename), sizeStr, uploadDate, uploaderName, m.id, window.escapeHtml(m.filename)]);
      })
      .join("");

    gcActions.style.display = "block";
  } catch (err) {
    gcStatus.innerHTML = ui("m_f9e39928a681db2a", [err.message]);
  } finally {
    gcRunBtn.disabled = false;
  }
}

function gcSelectAll() {
  document
    .querySelectorAll(".gc-check")
    .forEach((cb) => (cb.checked = true));
}

function gcDeselectAll() {
  document
    .querySelectorAll(".gc-check")
    .forEach((cb) => (cb.checked = false));
}

async function gcDeleteSelected() {
  const selectedIds = Array.from(
    document.querySelectorAll(".gc-check:checked"),
  ).map((cb) => Number(cb.dataset.id));

  if (selectedIds.length === 0) {
    Swal.fire(ui("m_f56c6c82203b33f6"), ui("m_6592941155924ffc"), "info");
    return;
  }

  const result = await Swal.fire({
    title: ui("m_517f80d5e802c50e"),
    html: ui("m_9505857337fbdb51", [selectedIds.length]),
    icon: "warning",
    showCancelButton: true,
    confirmButtonText: ui("m_2f9daa828907b93f"),
    cancelButtonText: ui("m_2cd0f3be8738a86c"),
    confirmButtonColor: "#d33",
  });

  if (!result.isConfirmed) return;

  const gcDeleteBtn = document.getElementById("gcDeleteBtn");
  gcDeleteBtn.disabled = true;
  gcDeleteBtn.innerHTML = window.uiInlineLoading({ text: ui("m_d37f24fb4e0d7b1d") });

  try {
    // 서버는 1회 호출당 ids 200개 상한을 두므로(자원 고갈 방지), 선택 항목이 많으면
    // 200개씩 나눠 순차 전송하고 결과를 합산한다. (전체 선택 기본값으로도 대량 GC 동작 보장)
    const CHUNK = 200;
    let totalDeleted = 0;
    const allErrors = [];
    for (let i = 0; i < selectedIds.length; i += CHUNK) {
      const chunk = selectedIds.slice(i, i + CHUNK);
      const res = await fetch("/api/admin/media/gc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: chunk }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || ui("m_c228558cf257fc49"));
      totalDeleted += data.deleted_count || 0;
      if (data.errors && data.errors.length > 0) allErrors.push(...data.errors);
    }

    let msg = ui("m_c6c7a20bf9453422", [totalDeleted]);
    if (allErrors.length > 0) {
      msg += ui("m_6d235d1bf6051e40", [allErrors.join("\n")]);
    }

    Swal.fire({
      icon: totalDeleted > 0 ? "success" : "warning",
      title: ui("m_a9734db6fb176602"),
      text: msg,
      confirmButtonText: ui("m_1aacb54c49924296"),
    });

    // 메인 목록 현재 페이지 재로드
    await loadMedia(mediaPage);

    // GC 결과 다시 검색
    runGarbageCollector();
  } catch (err) {
    Swal.fire(ui("m_0bc1fb72ae1be5c5"), err.message, "error");
  } finally {
    gcDeleteBtn.disabled = false;
    gcDeleteBtn.innerHTML =
      ui("m_ac1f587179b371a1");
  }
}

async function trackBacklinks(id, filename) {
  try {
    Swal.fire({
      title: ui("m_1157eee8b9283734"),
      text: ui("m_38372774e5415a6e"),
      allowOutsideClick: false,
      didOpen: () => {
        Swal.showLoading();
      },
    });

    const res = await fetch(`/api/admin/media/${id}/backlinks`);
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || ui("m_4291ef38489ca46a"));
    }
    const data = await res.json();

    let htmlContent = "";
    if (data.backlinks && data.backlinks.length > 0) {
      htmlContent =
        '<ul class="list-group text-start mt-3" style="max-height: 300px; overflow-y: auto;">';
      data.backlinks.forEach((item) => {
        if (item.type === "blog") {
          htmlContent += ui("m_1ce6d6664cb04530", [encodeURIComponent(item.id), window.escapeHtml(item.title || `#${item.id}`)]);
        } else if (item.type === "discussion") {
          // 토론: page_slug 가 있으면 /w/:slug?mode=discussions&id=:id 로 링크, 없으면 텍스트만
          const inner = item.page_slug
            ? `<a href="/w/${encodeURIComponent(item.page_slug)}?mode=discussions&id=${item.id}" target="_blank" class="text-decoration-none">${window.escapeHtml(item.title || `#${item.id}`)}</a>`
            : `<span>${window.escapeHtml(item.title || `#${item.id}`)}</span>`;
          htmlContent += ui("m_990b4c1d7cad17e1", [inner]);
        } else if (item.type === "ticket") {
          htmlContent += ui("m_33cbb4602073fb78", [item.id, window.escapeHtml(item.title || `#${item.id}`)]);
        } else {
          htmlContent += ui("m_f1e3e9ce7c1fb7dd", [encodeURIComponent(item.slug), window.escapeHtml(item.slug)]);
        }
      });
      htmlContent += "</ul>";
    } else {
      htmlContent =
        ui("m_7f6ade650e10d379");
    }

    Swal.fire({
      title: ui("m_fd33b1a4b07e2384"),
      html:
        ui("m_7ed12ac44a9887cb", [window.escapeHtml(filename)]) +
        htmlContent,
      width: "600px",
      confirmButtonText: ui("m_3fd47edce45b3603"),
    });
  } catch (err) {
    Swal.fire(ui("m_0bc1fb72ae1be5c5"), err.message, "error");
  }
}

// HTML onclick / onchange 속성(정적 HTML + innerHTML 생성 문자열)에서 호출되므로 window 로 노출한다.
window.runGarbageCollector = runGarbageCollector;
window.gcSelectAll = gcSelectAll;
window.gcDeselectAll = gcDeselectAll;
window.gcDeleteSelected = gcDeleteSelected;
window.changeMediaSort = changeMediaSort;
window.searchMedia = searchMedia;
window.goToMediaPage = goToMediaPage;
window.trackBacklinks = trackBacklinks;
window.deleteMedia = deleteMedia;
