const ALLOWED_CATEGORIES = new Set(['travel', 'food', 'friends', 'nature', 'culture']);
const MEMORY_INDEX_KEY = 'meta/memories.json';
const RATE_LIMIT = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_ATTEMPTS = 5;

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (request.method === 'GET' && pathname === '/api/memories') {
        const { memories, etag } = await listMemories(env, url.origin);
        const cacheHeaders = memoryListCacheHeaders(etag);

        if (etagMatches(request, etag)) {
          return new Response(null, {
            status: 304,
            headers: {
              ...corsHeaders(request, env),
              ...cacheHeaders,
            },
          });
        }

        return json({ memories }, 200, request, env, cacheHeaders);
      }

      if (request.method === 'POST' && pathname === '/api/session') {
        checkRateLimit(request);
        requireOwnerPasscode(request, env);
        return new Response(null, { status: 204, headers: corsHeaders(request, env) });
      }

      if (request.method === 'POST' && pathname === '/api/memories') {
        requireOwnerPasscode(request, env);
        const memory = await createMemory(request, env, url.origin);
        return json({ memory }, 201, request, env);
      }

      if (request.method === 'DELETE' && pathname.startsWith('/api/memories/')) {
        requireOwnerPasscode(request, env);
        const id = decodeURIComponent(pathname.slice('/api/memories/'.length));
        await deleteMemory(id, env);
        return new Response(null, { status: 204, headers: corsHeaders(request, env) });
      }

      if (request.method === 'PATCH' && pathname.startsWith('/api/memories/')) {
        requireOwnerPasscode(request, env);
        const id = decodeURIComponent(pathname.slice('/api/memories/'.length));
        const memory = await updateMemory(id, request, env, url.origin);
        return json({ memory }, 200, request, env);
      }

      if (request.method === 'GET' && pathname === '/api/assets') {
        return serveAsset(url, env, request);
      }

      return json({ error: 'Not found.' }, 404, request, env);
    } catch (error) {
      if (error && error.status) {
        return json({ error: error.message }, error.status, request, env);
      }

      console.error(error);
      return json({ error: 'Internal server error.' }, 500, request, env);
    }
  },
};

function corsHeaders(request, env) {
  const origin = env.ALLOWED_ORIGIN || request.headers.get('Origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,PATCH,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,x-owner-passcode',
    'Access-Control-Expose-Headers': 'ETag',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(payload, status, request, env, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(request, env),
      ...extraHeaders,
    },
  });
}

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function requireOwnerPasscode(request, env) {
  const expected = env.OWNER_PASSCODE;
  const provided = request.headers.get('x-owner-passcode');

  if (!expected) {
    throw fail(500, 'OWNER_PASSCODE is not configured.');
  }

  if (!provided || provided !== expected) {
    throw fail(401, 'Incorrect passcode.');
  }
}

function checkRateLimit(request) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const now = Date.now();
  const entry = RATE_LIMIT.get(ip);

  if (entry && now - entry.start < RATE_WINDOW_MS) {
    if (entry.count >= RATE_MAX_ATTEMPTS) {
      throw fail(429, 'Too many attempts. Try again later.');
    }
    entry.count += 1;
  } else {
    RATE_LIMIT.set(ip, { start: now, count: 1 });
  }

  if (RATE_LIMIT.size > 1000) {
    for (const [key, val] of RATE_LIMIT) {
      if (now - val.start > RATE_WINDOW_MS) RATE_LIMIT.delete(key);
    }
  }
}

async function listMemories(env, origin) {
  const object = await env.MEMORY_IMAGES.get(MEMORY_INDEX_KEY);
  const memories = await parseMemoryIndexObject(object);
  return {
    etag: memoryIndexEtag(object),
    memories: memories
      .slice()
      .sort((left, right) => Number(left.createdAt) - Number(right.createdAt))
      .map(memory => toPublicMemory(memory, origin)),
  };
}

async function createMemory(request, env, origin) {
  const formData = await request.formData();
  
  const lat = Number(formData.get('lat'));
  const lng = Number(formData.get('lng'));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw fail(400, 'Latitude and longitude are required.');
  }

  const id = crypto.randomUUID();
  const category = normalizeCategory(formData.get('category'));
  const caption = String(formData.get('caption') || '').trim().slice(0, 120);
  const date = String(formData.get('date') || '').trim();
  const createdAt = Number(formData.get('createdAt')) || Date.now();

  const imageCount = Number(formData.get('imageCount')) || 0;
  if (imageCount === 0) {
    throw fail(400, 'At least one image is required.');
  }

  const images = [];
  for (let i = 0; i < imageCount; i++) {
    const image = formData.get(`image_${i}`);
    const thumbnail = formData.get(`thumbnail_${i}`);
    if (!(image instanceof File) || !(thumbnail instanceof File)) continue;
    if (image.size > 8 * 1024 * 1024 || thumbnail.size > 1 * 1024 * 1024) throw fail(413, 'File too large.');
    
    const imageKey = `memories/${id}/image_${i}.${fileExtension(image)}`;
    const thumbnailKey = `memories/${id}/thumb_${i}.${fileExtension(thumbnail)}`;
    
    await putFile(env.MEMORY_IMAGES, imageKey, image);
    await putFile(env.MEMORY_IMAGES, thumbnailKey, thumbnail);
    images.push({ imageKey, thumbnailKey });
  }

  if (images.length === 0) {
    throw fail(400, 'At least one valid image is required.');
  }

  const memory = {
    id,
    lat,
    lng,
    caption,
    date,
    category,
    createdAt,
    images,
  };

  const memories = await readMemoryIndex(env);
  memories.push(memory);
  await writeMemoryIndex(env, memories);
  return toPublicMemory(memory, origin);
}

async function deleteMemory(id, env) {
  const memories = await readMemoryIndex(env);
  const memory = memories.find(item => item.id === id);
  if (!memory) {
    throw fail(404, 'Memory not found.');
  }

  const nextMemories = memories.filter(item => item.id !== id);
  const toDelete = [];
  if (memory.images) {
    for (const img of memory.images) {
      toDelete.push(env.MEMORY_IMAGES.delete(img.imageKey));
      toDelete.push(env.MEMORY_IMAGES.delete(img.thumbnailKey));
    }
  } else {
    toDelete.push(env.MEMORY_IMAGES.delete(memory.imageKey));
    toDelete.push(env.MEMORY_IMAGES.delete(memory.thumbnailKey));
  }
  await Promise.all(toDelete);
  await writeMemoryIndex(env, nextMemories);
}

async function updateMemory(id, request, env, origin) {
  const formData = await request.formData();
  const memories = await readMemoryIndex(env);
  const memoryIndex = memories.findIndex(item => item.id === id);
  if (memoryIndex === -1) throw fail(404, 'Memory not found.');

  const memory = memories[memoryIndex];
  if (!memory.images) {
    memory.images = [{ imageKey: memory.imageKey, thumbnailKey: memory.thumbnailKey }];
    delete memory.imageKey;
    delete memory.thumbnailKey;
  }

  const caption = formData.get('caption');
  const date = formData.get('date');
  const category = formData.get('category');
  const keptImages = JSON.parse(formData.get('keptImages') || '[]');
  
  const removedImages = memory.images.filter(img => !keptImages.find(k => k.imageKey === img.imageKey));
  for (const img of removedImages) {
    await env.MEMORY_IMAGES.delete(img.imageKey);
    await env.MEMORY_IMAGES.delete(img.thumbnailKey);
  }

  const newImageCount = Number(formData.get('newImageCount')) || 0;
  const newImages = [];
  const timestamp = Date.now();
  for (let i = 0; i < newImageCount; i++) {
    const image = formData.get(`new_image_${i}`);
    const thumbnail = formData.get(`new_thumbnail_${i}`);
    if (!(image instanceof File) || !(thumbnail instanceof File)) continue;
    
    const imageKey = `memories/${id}/image_${timestamp}_${i}.${fileExtension(image)}`;
    const thumbnailKey = `memories/${id}/thumb_${timestamp}_${i}.${fileExtension(thumbnail)}`;
    
    await putFile(env.MEMORY_IMAGES, imageKey, image);
    await putFile(env.MEMORY_IMAGES, thumbnailKey, thumbnail);
    newImages.push({ imageKey, thumbnailKey });
  }

  const updatedImages = [...keptImages, ...newImages];
  if (updatedImages.length === 0) throw fail(400, 'A memory must have at least one image.');

  if (caption !== null) memory.caption = String(caption).trim().slice(0, 120);
  if (date !== null) memory.date = String(date).trim();
  if (category !== null) memory.category = normalizeCategory(category);
  memory.images = updatedImages;

  await writeMemoryIndex(env, memories);
  return toPublicMemory(memory, origin);
}

async function serveAsset(url, env, request) {
  const key = url.searchParams.get('key');
  if (!key) {
    throw fail(400, 'Asset key is required.');
  }
  if (!key.startsWith('memories/')) {
    throw fail(403, 'Asset is not public.');
  }

  const object = await env.MEMORY_IMAGES.get(key);
  if (!object) {
    throw fail(404, 'Asset not found.');
  }

  const headers = new Headers(corsHeaders(request, env));
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  if (object.httpMetadata) {
    object.writeHttpMetadata(headers);
  }
  if (object.etag) {
    headers.set('ETag', object.etag);
  }

  return new Response(object.body, { headers });
}

function normalizeCategory(value) {
  return ALLOWED_CATEGORIES.has(value) ? value : 'travel';
}

function fileExtension(file) {
  const contentType = file.type || 'image/jpeg';
  if (contentType === 'image/png') return 'png';
  if (contentType === 'image/webp') return 'webp';
  if (contentType === 'image/gif') return 'gif';
  return 'jpg';
}

async function putFile(bucket, key, file) {
  await bucket.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type || 'image/jpeg' },
  });
}

async function readMemoryIndex(env) {
  const object = await env.MEMORY_IMAGES.get(MEMORY_INDEX_KEY);
  return parseMemoryIndexObject(object);
}

async function parseMemoryIndexObject(object) {
  if (!object) {
    return [];
  }

  try {
    const payload = await object.json();
    return Array.isArray(payload) ? payload : [];
  } catch {
    throw fail(500, 'Could not read memory index.');
  }
}

async function writeMemoryIndex(env, memories) {
  await env.MEMORY_IMAGES.put(MEMORY_INDEX_KEY, JSON.stringify(memories), {
    httpMetadata: { contentType: 'application/json' },
  });
}

function memoryListCacheHeaders(etag) {
  return {
    'Cache-Control': 'no-cache',
    ETag: etag,
  };
}

function memoryIndexEtag(object) {
  if (!object || !object.etag) {
    return '"empty-memories"';
  }

  const etag = String(object.etag);
  return etag.startsWith('"') || etag.startsWith('W/"') ? etag : `"${etag}"`;
}

function etagMatches(request, etag) {
  const header = request.headers.get('If-None-Match');
  if (!header) {
    return false;
  }

  return header === '*' || header.split(',').map(value => value.trim()).includes(etag);
}

function toPublicMemory(memory, origin) {
  const images = memory.images || [{ imageKey: memory.imageKey, thumbnailKey: memory.thumbnailKey }];
  return {
    id: memory.id,
    lat: memory.lat,
    lng: memory.lng,
    caption: memory.caption,
    date: memory.date,
    category: memory.category,
    createdAt: memory.createdAt,
    images: images.map(img => ({
      imageKey: img.imageKey,
      thumbnailKey: img.thumbnailKey,
      image: `${origin}/api/assets?key=${encodeURIComponent(img.imageKey)}`,
      thumbnail: `${origin}/api/assets?key=${encodeURIComponent(img.thumbnailKey)}`
    }))
  };
}
