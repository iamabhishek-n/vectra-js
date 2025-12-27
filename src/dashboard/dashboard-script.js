// State
let currentView = 'overview';
let currentProject = 'all';

// Init
document.addEventListener('DOMContentLoaded', () => {
    loadProjects();
    loadDashboardData();
    
    // Auto-refresh every 30s
    setInterval(loadDashboardData, 30000);
    
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
    if (latencyChartInst) latencyChartInst.destroy();
    latencyChartInst = new Chart(ctxL, {
        type: 'line',
        data: {
            labels,
            datasets: [{
                label: 'Latency (ms)',
                data: latencies,
                borderColor: '#4f46e5',
                tension: 0.4,
                fill: true,
                backgroundColor: 'rgba(79, 70, 229, 0.05)'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: { y: { beginAtZero: true, grid: { borderDash: [2, 4] } }, x: { grid: { display: false } } }
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
            scales: { y: { beginAtZero: true, grid: { borderDash: [2, 4] } }, x: { grid: { display: false } } }
        }
    });
}

async function loadTraces() {
    const traces = await fetchAPI('traces'); // Expects list of recent traces
    const tbody = document.getElementById('traces-table-body');
    tbody.innerHTML = '';

    if (!traces || traces.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="px-6 py-4 text-center text-sm text-slate-500">No traces found</td></tr>';
        return;
    }

    traces.forEach(t => {
        const row = document.createElement('tr');
        row.className = 'hover:bg-slate-50 transition-colors cursor-pointer';
        row.onclick = () => window.location.href = `/dashboard/trace.html?id=${t.trace_id}`;
        
        const statusColor = t.error && t.error !== '{}' ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700';
        const statusText = t.error && t.error !== '{}' ? 'Error' : 'Success';

        row.innerHTML = `
            <td class="px-6 py-4 whitespace-nowrap text-xs font-mono text-slate-500">${t.trace_id.slice(0, 8)}...</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-slate-900">${t.name}</td>
            <td class="px-6 py-4 whitespace-nowrap"><span class="px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${statusColor}">${statusText}</span></td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-slate-500">${t.end_time - t.start_time}ms</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-slate-500">${new Date(t.start_time).toLocaleString()}</td>
            <td class="px-6 py-4 whitespace-nowrap text-right text-sm font-medium text-indigo-600 hover:text-indigo-900">View</td>
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
        row.className = 'hover:bg-slate-50 transition-colors';
        
        row.innerHTML = `
            <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-slate-900">${s.session_id}</td>
            <td class="px-6 py-4 text-sm text-slate-500 truncate max-w-xs">${s.metadata?.last_query || '-'}</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-slate-500">${new Date(s.last_activity_time).toLocaleString()}</td>
            <td class="px-6 py-4 text-sm text-slate-500 font-mono text-xs">${JSON.stringify(s.metadata || {}).slice(0, 30)}...</td>
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
