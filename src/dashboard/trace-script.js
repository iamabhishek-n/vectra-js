document.addEventListener('DOMContentLoaded', () => {
    const urlParams = new URLSearchParams(window.location.search);
    const traceId = urlParams.get('id');

    if (!traceId) {
        alert('No trace ID provided');
        window.location.href = '/dashboard/';
        return;
    }

    loadTraceDetails(traceId);
});

async function loadTraceDetails(traceId) {
    try {
        const res = await fetch(`/api/observability/traces/${traceId}`);
        if (!res.ok) throw new Error('Failed to fetch trace details');
        
        const trace = await res.json();
        if (!trace || trace.length === 0) {
            document.getElementById('loading').innerHTML = '<div class="text-red-500">Trace not found</div>';
            return;
        }

        renderTrace(trace);
    } catch (e) {
        console.error(e);
        document.getElementById('loading').innerHTML = `<div class="text-red-500">Error: ${e.message}</div>`;
    }
}

function renderTrace(trace) {
    const content = document.getElementById('trace-content');
    const loading = document.getElementById('loading');
    
    // Sort spans by start time
    trace.sort((a, b) => a.start_time - b.start_time);
    
    const root = trace.find(s => !s.parent_span_id) || trace[0];
    const startTime = root.start_time;
    const endTime = Math.max(...trace.map(s => s.end_time));
    const totalDuration = endTime - startTime;

    // Header Info
    document.getElementById('header-trace-id').textContent = root.trace_id;
    document.getElementById('trace-timestamp').textContent = new Date(root.start_time).toLocaleString();
    document.getElementById('trace-duration').textContent = `${totalDuration}ms`;
    
    const modelInfo = root.model_name ? `${root.provider}/${root.model_name}` : (root.provider || '-');
    document.getElementById('trace-model').textContent = modelInfo;

    const hasError = trace.some(s => s.error && s.error !== '{}');
    const statusEl = document.getElementById('trace-status');
    if (hasError) {
        statusEl.className = 'px-3 py-1 rounded-full text-sm font-semibold bg-red-100 text-red-700';
        statusEl.textContent = 'Error';
    } else {
        statusEl.className = 'px-3 py-1 rounded-full text-sm font-semibold bg-green-100 text-green-700';
        statusEl.textContent = 'Success';
    }

    // Render Timeline
    const timelineContainer = document.getElementById('timeline-container');
    timelineContainer.innerHTML = '';
    
    trace.forEach(span => {
        const left = ((span.start_time - startTime) / totalDuration) * 100;
        const width = Math.max(((span.end_time - span.start_time) / totalDuration) * 100, 0.5); // min width 0.5%
        
        const row = document.createElement('div');
        row.className = 'relative group h-8 flex items-center';
        row.innerHTML = `
            <div class="w-1/4 min-w-[150px] text-xs font-medium text-slate-600 truncate pr-4" title="${span.name}">
                ${span.name}
            </div>
            <div class="flex-1 h-full relative">
                <div class="absolute top-1/2 -translate-y-1/2 h-4 bg-indigo-500/20 rounded-sm border border-indigo-500/40 hover:bg-indigo-500/40 transition-colors cursor-pointer"
                     style="left: ${left}%; width: ${width}%"
                     onclick="scrollToSpan('${span.span_id}')">
                </div>
                <div class="absolute top-1/2 -translate-y-1/2 text-[10px] text-slate-400 ml-2 pointer-events-none" style="left: ${left + width}%">
                    ${span.end_time - span.start_time}ms
                </div>
            </div>
        `;
        timelineContainer.appendChild(row);
    });

    // Render Detailed Spans
    const spansList = document.getElementById('spans-list');
    spansList.innerHTML = '';

    trace.forEach(span => {
        const card = document.createElement('div');
        card.id = `span-${span.span_id}`;
        card.className = 'bg-white rounded-lg border border-slate-200 shadow-sm overflow-hidden';
        
        const isError = span.error && span.error !== '{}';
        const borderColor = isError ? 'border-l-4 border-l-red-500' : 'border-l-4 border-l-indigo-500';
        
        card.innerHTML = `
            <div class="px-6 py-4 bg-slate-50 border-b border-slate-100 flex justify-between items-center ${borderColor}">
                <div>
                    <h4 class="text-sm font-bold text-slate-900 font-mono">${span.name}</h4>
                    <div class="text-xs text-slate-500 mt-1 font-mono">${span.span_id}</div>
                </div>
                <div class="text-right">
                    <div class="text-sm font-semibold text-slate-700">${span.end_time - span.start_time}ms</div>
                    <div class="text-xs text-slate-400">${new Date(span.start_time).toLocaleTimeString()}</div>
                </div>
            </div>
            <div class="p-6 space-y-4">
                ${renderJSONSection('Input', span.input)}
                ${renderJSONSection('Output', span.output)}
                ${renderJSONSection('Attributes', span.attributes)}
                ${isError ? renderJSONSection('Error', span.error, true) : ''}
            </div>
        `;
        spansList.appendChild(card);
    });

    loading.classList.add('hidden');
    content.classList.remove('hidden');
    lucide.createIcons();
}

function renderJSONSection(title, data, isError = false) {
    if (!data || data === '{}') return '';
    
    let parsed = data;
    if (typeof data === 'string') {
        try {
            parsed = JSON.parse(data);
        } catch (e) {
            parsed = data; // Keep as string if parsing fails
        }
    }

    if (Object.keys(parsed).length === 0) return '';

    const jsonHtml = syntaxHighlight(parsed);
    const bgClass = isError ? 'bg-red-50' : 'bg-slate-900';
    const textClass = isError ? 'text-red-900' : 'text-slate-50';

    return `
        <div>
            <h5 class="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">${title}</h5>
            <div class="${bgClass} rounded-lg p-4 overflow-x-auto">
                <pre class="text-xs font-mono ${textClass}"><code>${jsonHtml}</code></pre>
            </div>
        </div>
    `;
}

function syntaxHighlight(json) {
    if (typeof json !== 'string') {
        json = JSON.stringify(json, null, 2);
    }
    json = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, function (match) {
        let cls = 'text-purple-300'; // number
        if (/^"/.test(match)) {
            if (/:$/.test(match)) {
                cls = 'text-indigo-300'; // key
            } else {
                cls = 'text-green-300'; // string
            }
        } else if (/true|false/.test(match)) {
            cls = 'text-blue-300'; // boolean
        } else if (/null/.test(match)) {
            cls = 'text-slate-400'; // null
        }
        return '<span class="' + cls + '">' + match + '</span>';
    });
}

function scrollToSpan(spanId) {
    const el = document.getElementById(`span-${spanId}`);
    if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('ring-2', 'ring-indigo-500', 'ring-offset-2');
        setTimeout(() => el.classList.remove('ring-2', 'ring-indigo-500', 'ring-offset-2'), 2000);
    }
}
