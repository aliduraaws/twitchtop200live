const clientId = 'gky3gvnl2o5v2x26xrw5i79hs17nrk';
const accessToken = '8wq193puwfzavy6m63ltbi96pjfe6x'; // Must be valid Bearer token
//const clientId = 'YOUR_CLIENT_ID_HERE'; // Replace with your Twitch Client ID
//const accessToken = 'YOUR_ACCESS_TOKEN_HERE'; // Replace with your Twitch Bearer Token
const tableBody = document.querySelector('#streamers-table tbody');
const tableHeaders = document.querySelectorAll('#streamers-table th');
let streams = [];
let currentSort = { column: 'viewer_count', direction: 'desc' };
const CACHE_KEY = 'twitch_streams_cache';
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function fetchWithRetry(url, options, retries = 2, backoff = 500) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('Ratelimit-Reset')) || backoff;
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
        continue;
      }
      if (!response.ok) throw new Error(`HTTP error: ${response.status} for ${url}`);
      return await response.json();
    } catch (error) {
      if (i === retries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, backoff * (i + 1)));
    }
  }
}

function formatUptime(startedAt) {
  if (!startedAt) return 'N/A';
  const start = new Date(startedAt);
  const now = new Date();
  const diffMs = now - start;
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function getCachedData() {
  const cached = localStorage.getItem(CACHE_KEY);
  if (!cached) return null;
  const { data, timestamp } = JSON.parse(cached);
  if (Date.now() - timestamp > CACHE_TTL) {
    localStorage.removeItem(CACHE_KEY);
    return null;
  }
  // Ensure viewer_rank is set for cached data
  data.sort((a, b) => b.viewer_count - a.viewer_count);
  data.forEach((stream, index) => {
    stream.viewer_rank = index + 1;
    console.log(`Cached rank for ${stream.user_name}: ${stream.viewer_rank}`); // Debug
  });
  return data;
}

function setCachedData(data) {
  localStorage.setItem(CACHE_KEY, JSON.stringify({ data, timestamp: Date.now() }));
}

async function fetchTopStreams() {
  try {
    const loadingSpinner = document.createElement('div');
    loadingSpinner.id = 'loading-spinner';
    loadingSpinner.innerHTML = 'Loading streams...';
    tableBody.parentNode.insertBefore(loadingSpinner, tableBody);
    loadingSpinner.style.display = 'block';
    tableBody.innerHTML = '';

    // Optional: Clear cache to reset invalid data (uncomment to force clear)
    // localStorage.removeItem(CACHE_KEY);

    // Check cache
    const cachedStreams = getCachedData();
    if (cachedStreams) {
      streams = cachedStreams;
      sortAndRender();
      return;
    }

    streams = [];

    // Fetch streams (up to 200)
    let cursor = null;
    for (let i = 0; i < 5; i++) {
      const url = new URL('https://api.twitch.tv/helix/streams');
      url.searchParams.set('first', '100');
      if (cursor) url.searchParams.set('after', cursor);

      console.log(`Fetching streams page ${i + 1}`);
      const data = await fetchWithRetry(url.toString(), {
        headers: {
          'Client-ID': clientId,
          'Authorization': `Bearer ${accessToken}`
        }
      });

      streams.push(...data.data.map(stream => ({
        user_id: stream.user_id,
        user_name: stream.user_name,
        user_login: stream.user_login,
        viewer_count: stream.viewer_count,
        game_name: stream.game_name || 'Unknown',
        started_at: stream.started_at,
        followers: null,
        profile_image_url: null,
        viewer_rank: null
      })));

      cursor = data.pagination.cursor;
      if (!cursor || streams.length >= 200) break;
    }

    // Assign viewer ranks based on viewer count
    streams.sort((a, b) => b.viewer_count - a.viewer_count);
    streams.forEach((stream, index) => {
      stream.viewer_rank = index + 1;
      console.log(`Assigned rank for ${stream.user_name}: ${stream.viewer_rank}`); // Debug
    });

    // Fetch profile images
    const userLogins = streams.map(s => s.user_login);
    for (let i = 0; i < userLogins.length; i += 100) {
      const batch = userLogins.slice(i, i + 100);
      const url = new URL('https://api.twitch.tv/helix/users');
      batch.forEach(login => url.searchParams.append('login', login));
      console.log(`Fetching user profiles for batch ${i / 100 + 1}`);
      const data = await fetchWithRetry(url.toString(), {
        headers: {
          'Client-ID': clientId,
          'Authorization': `Bearer ${accessToken}`
        }
      });

      data.data.forEach(user => {
        const stream = streams.find(s => s.user_login === user.login);
        if (stream) stream.profile_image_url = user.profile_image_url;
      });
    }

    // Fetch follower counts in parallel batches
    const batchSize = 50;
    for (let i = 0; i < streams.length; i += batchSize) {
      const batch = streams.slice(i, i + batchSize);
      console.log(`Fetching followers for batch ${i / batchSize + 1}`);
      const promises = batch.map(async stream => {
        try {
          const url = new URL('https://api.twitch.tv/helix/channels/followers');
          url.searchParams.set('broadcaster_id', stream.user_id);
          const data = await fetchWithRetry(url.toString(), {
            headers: {
              'Client-ID': clientId,
              'Authorization': `Bearer ${accessToken}`
            }
          });
          stream.followers = data.total || 0;
        } catch (error) {
          console.error(`Failed to fetch followers for ${stream.user_name}: ${error.message}`);
          stream.followers = 'N/A';
        }
      });
      await Promise.allSettled(promises);
    }

    // Cache data
    setCachedData(streams);

    // Render
    sortAndRender();

  } catch (error) {
    console.error('Error fetching streams:', error);
    tableBody.innerHTML = `<tr><td colspan="8">Error loading streams: ${error.message}</td></tr>`;
  } finally {
    const loadingSpinner = document.getElementById('loading-spinner');
    if (loadingSpinner) loadingSpinner.style.display = 'none';
  }
}

function sortAndRender() {
  const { column, direction } = currentSort;
  const sortedStreams = [...streams].sort((a, b) => {
    let valA = a[column];
    let valB = b[column];
    
    if (column === 'viewer_count' || column === 'user_id') {
      valA = Number(valA) || 0;
      valB = Number(valB) || 0;
      return direction === 'asc' ? valA - valB : valB - valA;
    }
    
    if (column === 'followers') {
      valA = valA === 'N/A' ? -1 : Number(valA);
      valB = valB === 'N/A' ? -1 : Number(valB);
      return direction === 'asc' ? valA - valB : valB - valA;
    }
    
    if (column === 'uptime') {
      valA = a.started_at ? new Date(a.started_at).getTime() : Infinity;
      valB = b.started_at ? new Date(b.started_at).getTime() : Infinity;
      return direction === 'asc' ? valA - valB : valB - valA;
    }
    
    return direction === 'asc'
      ? (valA || '').localeCompare(valB || '')
      : (valB || '').localeCompare(valA || '');
  }).slice(0, 200);

  tableBody.innerHTML = '';
  sortedStreams.forEach(stream => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${stream.viewer_rank || 'N/A'}</td>
      <td title="${stream.user_name}"><img class="profile-img" src="${stream.profile_image_url || 'default-profile.png'}" alt="${stream.user_name}"/> ${stream.user_name}</td>
      <td>${stream.user_id}</td>
      <td>${stream.viewer_count.toLocaleString()}</td>
      <td>${stream.game_name}</td>
      <td>${stream.followers === 'N/A' ? 'N/A' : stream.followers.toLocaleString()}</td>
      <td>${formatUptime(stream.started_at)}</td>
      <td><a href="https://twitch.tv/${stream.user_login}" target="_blank">Visit Channel</a></td>
    `;
    tableBody.appendChild(row);
  });

  // Update arrows
  tableHeaders.forEach(header => {
    const arrow = header.querySelector('.sort-arrow');
    const sortColumn = header.getAttribute('data-sort');
    if (sortColumn === column) {
      arrow.textContent = direction === 'asc' ? '↑' : '↓';
    } else {
      arrow.textContent = '';
    }
  });
}

tableHeaders.forEach(header => {
  header.addEventListener('click', () => {
    const column = header.getAttribute('data-sort');
    if (currentSort.column === column) {
      currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
    } else {
      currentSort.column = column;
      currentSort.direction = column === 'viewer_count' || column === 'followers' ? 'desc' : 'asc';
    }
    sortAndRender();
  });
});

fetchTopStreams();