// State
let currentView = 'overview';
let currentProject = 'all';
let lastStats = null;

// Init
document.addEventListener('DOMContentLoaded', () => {
    loadProjects();
    loadDashboardData();
    
    // Auto-refresh every 30s
    setInterval(loadDashboardData, 30000);
    
    // Initialize Icons
    if (window.lucide) {
        window.lucide.createIcons();
    }
    
    // Project filter
    const projectSelect = document.getElementById('projectSelect');
    if (projectSelect) {
        projectSelect.addEventListener('change', (e) => {
            currentProject = e.target.value;
            loadDashboardData();
        });
    }
});

function switchView(view) {
    currentView = view;
    
    // Update content visibility
    ['overview', 'traces', 'sessions'].forEach(v => {
        const div = document.getElementById(`view-${v}`);
        if (v === view) {
            div.classList.remove('hidden');
        } else {
            div.classList.add('hidden');
        }
    });

    // Update Sidebar Links
    document.querySelectorAll('.sidebar-link').forEach(el => {
        el.classList.remove('active', 'bg-gray-100', 'text-slate-900');
        el.classList.add('text-gray-600');
    });
    
    const btn = document.getElementById(`btn-${view}`);
    if (btn) {
        btn.classList.add('active', 'bg-gray-100', 'text-slate-900');
        btn.classList.remove('text-gray-600');
    }

    if (view === 'traces') loadTraces();
    if (view === 'sessions') loadSessions();
}

async function fetchAPI(endpoint) {
    try {
        const url = `/api/observability/${endpoint}${currentProject !== 'all' ? `?projectId=${currentProject}` : ''}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error('API Error');
        return await res.json();
    } catch (e) {
        console.error('Fetch error:', e);
        return null;
    }
}

async function loadProjects() {
    const projects = await fetchAPI('projects');
    const select = document.getElementById('projectSelect');
    if (projects && projects.length > 0) {
        // Keep 'all' option
        // Add projects
        projects.forEach(p => {
            if (p === 'all') return; // skip if somehow in db
            const opt = document.createElement('option');
            opt.value = p;
            opt.textContent = p;
            select.appendChild(opt);
        });
    }
}

async function loadDashboardData() {
    const stats = await fetchAPI('stats');
    if (!stats) return;

    lastStats = stats;

    // Update Stats Cards
    document.getElementById('stat-total-req').textContent = stats.totalRequests || 0;
    document.getElementById('stat-avg-latency').textContent = Math.round(stats.avgLatency || 0);
    document.getElementById('stat-tokens').textContent = ((stats.totalPromptChars || 0) + (stats.totalCompletionChars || 0)).toLocaleString();
    document.getElementById('stat-errors').textContent = '0%'; // Placeholder for now

    // Update Charts
    updateCharts(stats.history);
}

let latencyChartInst = null;
let tokenChartInst = null;

function updateCharts(history = []) {
    // History is expected to be array of { timestamp, latency, tokens }
    // If not provided by API yet, mock or skip
    if (!history.length) return;

    const labels = history.map(h => new Date(h.timestamp).toLocaleTimeString());
    const latencies = history.map(h => h.latency);
    const tokens = history.map(h => h.tokens);

    // Latency Chart
    const ctxL = document.getElementById('latencyChart').getContext('2d');
    const isDark = document.documentElement.classList.contains('dark');
    const gridColor = isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)';
    const textColor = isDark ? '#9ca3af' : '#64748b';

    if (latencyChartInst) latencyChartInst.destroy();
    latencyChartInst = new Chart(ctxL, {
        type: 'line',
        data: {
            labels,
            datasets: [{
                label: 'Latency (ms)',
                data: latencies,
                borderColor: '#8b5cf6',
                tension: 0.4,
                fill: true,
                backgroundColor: isDark ? 'rgba(139, 92, 246, 0.1)' : 'rgba(139, 92, 246, 0.05)'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: { 
                y: { 
                    beginAtZero: true, 
                    grid: { color: gridColor, borderDash: [2, 4] },
                    ticks: { color: textColor }
                }, 
                x: { 
                    grid: { display: false },
                    ticks: { color: textColor }
                } 
            }
        }
    });

    // Token Chart
    const ctxT = document.getElementById('tokenChart').getContext('2d');
    if (tokenChartInst) tokenChartInst.destroy();
    tokenChartInst = new Chart(ctxT, {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                label: 'Tokens',
                data: tokens,
                backgroundColor: '#0ea5e9',
                borderRadius: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: { 
                y: { 
                    beginAtZero: true, 
                    grid: { color: gridColor, borderDash: [2, 4] },
                    ticks: { color: textColor }
                }, 
                x: { 
                    grid: { display: false },
                    ticks: { color: textColor }
                } 
            }
        }
    });
}

async function loadTraces() {
    const traces = await fetchAPI('traces'); // Expects list of recent traces
    const tbody = document.getElementById('traces-table-body');
    tbody.innerHTML = '';

    if (!traces || traces.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="px-6 py-4 text-center text-sm text-slate-500 dark:text-gray-400">No traces found</td></tr>';
        return;
    }

    traces.forEach(t => {
        const row = document.createElement('tr');
        row.className = 'hover:bg-slate-50 dark:hover:bg-white/5 transition-colors cursor-pointer';
        row.onclick = () => window.location.href = `/dashboard/trace.html?id=${t.trace_id}`;
        
        const statusColor = t.error && t.error !== '{}' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' : 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400';
        const statusText = t.error && t.error !== '{}' ? 'Error' : 'Success';

        row.innerHTML = `
            <td class="px-6 py-4 whitespace-nowrap text-xs font-mono text-slate-500 dark:text-gray-400">${t.trace_id.slice(0, 8)}...</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-slate-900 dark:text-white">${t.name}</td>
            <td class="px-6 py-4 whitespace-nowrap"><span class="px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${statusColor}">${statusText}</span></td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-slate-500 dark:text-gray-400">${t.end_time - t.start_time}ms</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-slate-500 dark:text-gray-400">${new Date(t.start_time).toLocaleString()}</td>
            <td class="px-6 py-4 whitespace-nowrap text-right text-sm font-medium text-brand-600 dark:text-brand-400 hover:text-brand-900 dark:hover:text-brand-300">View</td>
        `;
        tbody.appendChild(row);
    });
}

async function loadSessions() {
    const sessions = await fetchAPI('sessions');
    const tbody = document.getElementById('sessions-table-body');
    tbody.innerHTML = '';

    if (!sessions || sessions.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="px-6 py-4 text-center text-sm text-slate-500">No active sessions</td></tr>';
        return;
    }

    sessions.forEach(s => {
        const row = document.createElement('tr');
        row.className = 'hover:bg-slate-50 dark:hover:bg-white/5 transition-colors';
        
        row.innerHTML = `
            <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-slate-900 dark:text-white">${s.session_id}</td>
            <td class="px-6 py-4 text-sm text-slate-500 dark:text-gray-400 truncate max-w-xs">${s.metadata?.last_query || '-'}</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-slate-500 dark:text-gray-400">${new Date(s.last_activity_time).toLocaleString()}</td>
            <td class="px-6 py-4 text-sm text-slate-500 dark:text-gray-400 font-mono text-xs">${JSON.stringify(s.metadata || {}).slice(0, 30)}...</td>
        `;
        tbody.appendChild(row);
    });
}

/* Modal functions removed as trace details are now on a separate page */
function showTraceDetails(traceId) {
    window.location.href = `/dashboard/trace.html?id=${traceId}`;
}

function closeModal() {
    // Deprecated
}

function toggleTheme() {
    if (document.documentElement.classList.contains('dark')) {
        document.documentElement.classList.remove('dark');
        localStorage.setItem('color-theme', 'light');
    } else {
        document.documentElement.classList.add('dark');
        localStorage.setItem('color-theme', 'dark');
    }

    if (lastStats && lastStats.history) {
        updateCharts(lastStats.history);
    }
}
