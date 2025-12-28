document.addEventListener('DOMContentLoaded', () => {
    // --- Dark Mode Logic ---
    const themeToggleBtn = document.getElementById('theme-toggle');
    const darkIcon = document.getElementById('theme-toggle-dark-icon');
    const lightIcon = document.getElementById('theme-toggle-light-icon');

    // Initial State
    if (localStorage.getItem('color-theme') === 'dark' || (!('color-theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
        document.documentElement.classList.add('dark');
        if (lightIcon) lightIcon.classList.remove('hidden');
    } else {
        document.documentElement.classList.remove('dark');
        if (darkIcon) darkIcon.classList.remove('hidden');
    }

    // Toggle Event
    if (themeToggleBtn) {
        themeToggleBtn.addEventListener('click', () => {
            // Toggle icons
            if (darkIcon) darkIcon.classList.toggle('hidden');
            if (lightIcon) lightIcon.classList.toggle('hidden');

            // If is set in local storage
            if (localStorage.getItem('color-theme')) {
                if (localStorage.getItem('color-theme') === 'light') {
                    document.documentElement.classList.add('dark');
                    localStorage.setItem('color-theme', 'dark');
                } else {
                    document.documentElement.classList.remove('dark');
                    localStorage.setItem('color-theme', 'light');
                }
            } else {
                // If not in local storage
                if (document.documentElement.classList.contains('dark')) {
                    document.documentElement.classList.remove('dark');
                    localStorage.setItem('color-theme', 'light');
                } else {
                    document.documentElement.classList.add('dark');
                    localStorage.setItem('color-theme', 'dark');
                }
            }
            
            // Trigger preview update
            if (typeof updatePreview === 'function') updatePreview();
        });
    }

    // --- Navigation Logic (Smooth Scrolling & Scroll Spy) ---
    const links = document.querySelectorAll('.nav-item');
    const sections = document.querySelectorAll('section');
    const mainScroll = document.getElementById('main-scroll');
    let isManualScroll = false;

    // Click to scroll
    links.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const targetId = link.getAttribute('data-target');
            const targetSection = document.getElementById(targetId);
            
            if (targetSection) {
                isManualScroll = true;
                // Highlight immediately
                updateSidebarState(targetId);
                
                targetSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
                
                // Reset manual scroll flag after animation
                setTimeout(() => { isManualScroll = false; }, 1000);
            }
        });
    });

    // Scroll Spy
    mainScroll.addEventListener('scroll', () => {
        // Sync Scroll to Preview
        const previewScroll = document.getElementById('preview-scroll');
        if (previewScroll) {
            const maxMain = mainScroll.scrollHeight - mainScroll.clientHeight;
            const maxPreview = previewScroll.scrollHeight - previewScroll.clientHeight;
            if (maxMain > 0) {
                const percentage = mainScroll.scrollTop / maxMain;
                previewScroll.scrollTop = percentage * maxPreview;
            }
        }

        if (isManualScroll) return;

        let current = '';
        sections.forEach(section => {
            const sectionTop = section.offsetTop;
            // Adjust offset for better trigger point (e.g. 1/3 down the viewport)
            if (mainScroll.scrollTop >= (sectionTop - 20)) {
                current = section.getAttribute('id');
            }
        });
        
        // If we are at the top, force the first one
        if (mainScroll.scrollTop < 50) {
            current = sections[0].getAttribute('id');
        }

        if (current) updateSidebarState(current);
        updatePreviewHighlight(current);
    });

    function updateSidebarState(currentId) {
        links.forEach(link => {
            link.classList.remove('bg-brand-50', 'text-brand-600', 'active', 'border-l-4', 'border-brand-600');
            link.classList.add('text-gray-600', 'hover:bg-gray-50');
            
            // We use a slight visual indicator for active state
            if (link.getAttribute('data-target') === currentId) {
                link.classList.remove('text-gray-600', 'hover:bg-gray-50');
                link.classList.add('bg-brand-50', 'text-brand-600', 'active');
            }
        });
    }

    // --- Accordion Logic ---
    document.querySelectorAll('.accordion-header').forEach(header => {
        header.addEventListener('click', () => {
            const targetId = header.getAttribute('data-target');
            const targetContent = document.getElementById(targetId);
            const icon = header.querySelector('.accordion-icon');
            
            const isHidden = targetContent.classList.contains('hidden');
            
            // Auto-collapse others (if enabled)
            const autoFocus = document.getElementById('auto-focus-toggle')?.checked;
            if (autoFocus) {
                document.querySelectorAll('.accordion-content').forEach(content => {
                    // If it's not the one we clicked, hide it
                    if (content.id !== targetId) {
                        content.classList.add('hidden');
                        // Reset icon rotation for others
                        const otherHeader = document.querySelector(`[data-target="${content.id}"]`);
                        if (otherHeader) {
                            otherHeader.querySelector('.accordion-icon').classList.remove('rotate-180');
                        }
                    }
                });
            }

            // Toggle clicked
            if (isHidden) {
                targetContent.classList.remove('hidden');
                icon.classList.add('rotate-180');
            } else {
                targetContent.classList.add('hidden');
                icon.classList.remove('rotate-180');
            }
        });
    });

    // --- Temperature Slider Sync ---
    const tempSlider = document.getElementById('temp-slider');
    const tempInput = document.getElementById('temp-input');
    
    if (tempSlider && tempInput) {
        tempSlider.addEventListener('input', (e) => {
            tempInput.value = e.target.value;
            triggerChange(); // To update preview
        });
        
        tempInput.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            if (val >= 0 && val <= 1) {
                tempSlider.value = val;
            }
            triggerChange();
        });
    }

    // --- Key-Value Headers Builder ---
    const addHeaderBtn = document.getElementById('add-header-btn');
    const headersBuilder = document.getElementById('headers-builder');
    
    if (addHeaderBtn) {
        addHeaderBtn.addEventListener('click', () => addHeaderRow());
    }

    function addHeaderRow(key = '', value = '') {
        const row = document.createElement('div');
        row.className = 'flex items-center space-x-2 header-row';
        row.innerHTML = `
            <input type="text" placeholder="Key" value="${key}" class="header-key block w-1/2 rounded-md border-gray-300 dark:border-white/10 bg-white dark:bg-dark-950 text-slate-900 dark:text-white shadow-sm focus:border-brand-500 focus:ring-brand-500 sm:text-sm py-2 px-3 border">
            <input type="text" placeholder="Value" value="${value}" class="header-value block w-1/2 rounded-md border-gray-300 dark:border-white/10 bg-white dark:bg-dark-950 text-slate-900 dark:text-white shadow-sm focus:border-brand-500 focus:ring-brand-500 sm:text-sm py-2 px-3 border">
            <button type="button" class="remove-header p-2 text-gray-400 hover:text-red-500">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
            </button>
        `;
        
        row.querySelector('.remove-header').addEventListener('click', () => {
            row.remove();
            updateHiddenHeaders();
            triggerChange();
        });

        row.querySelectorAll('input').forEach(input => {
            input.addEventListener('input', () => {
                updateHiddenHeaders();
                triggerChange();
            });
        });

        headersBuilder.appendChild(row);
    }

    function updateHiddenHeaders() {
        const rows = headersBuilder.querySelectorAll('.header-row');
        const headers = {};
        let hasHeaders = false;

        rows.forEach(row => {
            const key = row.querySelector('.header-key').value.trim();
            const value = row.querySelector('.header-value').value.trim();
            if (key) {
                headers[key] = value;
                hasHeaders = true;
            }
        });

        const input = document.querySelector('[name="llm.defaultHeaders"]');
        if (input) {
            input.value = hasHeaders ? JSON.stringify(headers) : '';
        }
    }

    function triggerChange() {
        document.getElementById('config-form').dispatchEvent(new Event('change'));
    }

    // --- Load Config ---
    fetchConfig();

    // --- Save Config ---
    document.getElementById('save-btn').addEventListener('click', saveConfig);
    
    // --- Backend Toggle Logic ---
    const btnNode = document.getElementById('backend-node');
    const btnPython = document.getElementById('backend-python');
    
    if (btnNode && btnPython) {
        btnNode.addEventListener('click', () => setBackend('node'));
        btnPython.addEventListener('click', () => setBackend('python'));
    }

    // --- OpenRouter Logic ---
    const providerSelect = document.querySelector('[name="llm.provider"]');
    const openRouterExtras = document.getElementById('openrouter-extras');
    const openRouterHint = document.getElementById('openrouter-base-hint');
    
    if (providerSelect) {
        providerSelect.addEventListener('change', () => {
            toggleOpenRouter(providerSelect.value);
            updatePreview();
        });
    }

    const orInputs = ['or-referer', 'or-title'];
    orInputs.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('input', () => {
                updateOpenRouterHeaders();
                updatePreview();
            });
        }
    });

    function toggleOpenRouter(provider) {
        if (!openRouterExtras) return;
        if (provider === 'openrouter') {
            openRouterExtras.classList.remove('hidden');
            if (openRouterHint) openRouterHint.classList.remove('hidden');
        } else {
            openRouterExtras.classList.add('hidden');
            if (openRouterHint) openRouterHint.classList.add('hidden');
        }
    }

    function updateOpenRouterHeaders() {
        const referer = document.getElementById('or-referer').value.trim();
        const title = document.getElementById('or-title').value.trim();
        
        // We sync these to the existing headers mechanism
        // First, get existing custom headers
        const headersBuilder = document.getElementById('headers-builder');
        const rows = headersBuilder.querySelectorAll('.header-row');
        const headers = {};
        
        rows.forEach(row => {
            const key = row.querySelector('.header-key').value.trim();
            const value = row.querySelector('.header-value').value.trim();
            if (key) headers[key] = value;
        });

        // Add/Update OpenRouter specific headers
        if (referer) headers['HTTP-Referer'] = referer;
        if (title) headers['X-Title'] = title;

        // Update the hidden input
        const input = document.querySelector('[name="llm.defaultHeaders"]');
        if (input) {
            input.value = Object.keys(headers).length > 0 ? JSON.stringify(headers) : '';
        }
    }

    // --- Live Preview Listeners ---
    document.getElementById('config-form').addEventListener('input', updatePreview);
    document.getElementById('config-form').addEventListener('change', updatePreview);

    // --- Conditional Section Visibility ---
    const chunkingStrategyEl = document.querySelector('[name="chunking.strategy"]');
    const agenticLlmSection = document.getElementById('agentic-llm-content');
    if (chunkingStrategyEl && agenticLlmSection) {
        const toggleAgentic = () => {
            const isAgentic = chunkingStrategyEl.value === 'agentic';
            agenticLlmSection.classList.toggle('hidden', !isAgentic);
        };
        chunkingStrategyEl.addEventListener('change', () => { toggleAgentic(); updatePreview(); });
        toggleAgentic();
    }

    const retrievalStrategyEl = document.querySelector('[name="retrieval.strategy"]');
    const retrievalLlmSection = document.getElementById('retrieval-llm-content');
    if (retrievalStrategyEl && retrievalLlmSection) {
        const toggleRetrievalLLM = () => {
            const needsLLM = ['hyde','multi_query'].includes(retrievalStrategyEl.value);
            retrievalLlmSection.classList.toggle('hidden', !needsLLM);
        };
        retrievalStrategyEl.addEventListener('change', () => { toggleRetrievalLLM(); updatePreview(); });
        toggleRetrievalLLM();
    }

    const rerankingEnabledEl = document.querySelector('[name="reranking.enabled"]');
    const rerankingLlmSection = document.getElementById('reranking-llm-content');
    if (rerankingEnabledEl && rerankingLlmSection) {
        const toggleRerankLLM = () => {
            rerankingLlmSection.classList.toggle('hidden', !rerankingEnabledEl.checked);
        };
        rerankingEnabledEl.addEventListener('change', () => { toggleRerankLLM(); updatePreview(); });
        toggleRerankLLM();
    }
});

// Global state for current config type (Python vs JS)
let isPythonBackend = false;

function setBackend(type) {
    isPythonBackend = (type === 'python');
    
    const btnNode = document.getElementById('backend-node');
    const btnPython = document.getElementById('backend-python');
    
    const activeClass = 'px-3 py-1.5 text-sm font-medium rounded-md transition-all duration-200 text-brand-600 dark:text-brand-400 bg-white dark:bg-brand-900/20 shadow-sm';
    const inactiveClass = 'px-3 py-1.5 text-sm font-medium rounded-md transition-all duration-200 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white';
    
    if (isPythonBackend) {
        btnPython.className = activeClass;
        btnNode.className = inactiveClass;
    } else {
        btnNode.className = activeClass;
        btnPython.className = inactiveClass;
    }
    
    updatePreview();
}

async function fetchConfig() {
    try {
        const response = await fetch('/config');
        if (!response.ok) throw new Error('Failed to load config');
        const config = await response.json();
        
        // Detect backend type from loaded config
        const detectedPython = detectBackendFromConfig(config);
        setBackend(detectedPython ? 'python' : 'node');
        
        populateForm(config);
    } catch (error) {
        showStatus(error.message, 'error');
    }
}

function detectBackendFromConfig(config) {
    if (config.embedding && config.embedding.api_key !== undefined) return true;
    if (config.llm && config.llm.api_key !== undefined) return true;
    return false;
}

function populateForm(config) {
    // Embedding
    setVal('embedding.provider', config.embedding?.provider);
    setVal('embedding.apiKey', config.embedding?.apiKey || config.embedding?.api_key);
    setVal('embedding.modelName', config.embedding?.modelName || config.embedding?.model_name);
    setVal('embedding.dimensions', config.embedding?.dimensions);

    // LLM
    setVal('llm.provider', config.llm?.provider);
    setVal('llm.apiKey', config.llm?.apiKey || config.llm?.api_key);
    setVal('llm.modelName', config.llm?.modelName || config.llm?.model_name);
    setVal('llm.temperature', config.llm?.temperature);
    
    // Update Slider
    const tempSlider = document.getElementById('temp-slider');
    if (tempSlider && config.llm?.temperature !== undefined) {
        tempSlider.value = config.llm.temperature;
    }

    setVal('llm.maxTokens', config.llm?.maxTokens || config.llm?.max_tokens);
    setVal('llm.baseUrl', config.llm?.baseUrl || config.llm?.base_url);
    
    // Headers Builder
    const headers = config.llm?.defaultHeaders || config.llm?.default_headers;
    const headersBuilder = document.getElementById('headers-builder');
    headersBuilder.innerHTML = ''; // Clear
    
    let orReferer = '';
    let orTitle = '';

    if (headers && typeof headers === 'object') {
        Object.entries(headers).forEach(([k, v]) => {
            if (k === 'HTTP-Referer') orReferer = v;
            else if (k === 'X-Title') orTitle = v;
            else addHeaderRow(k, v);
        });
    }
    
    // OpenRouter Specifics
    const orRefererInput = document.getElementById('or-referer');
    const orTitleInput = document.getElementById('or-title');
    if (orRefererInput) orRefererInput.value = orReferer;
    if (orTitleInput) orTitleInput.value = orTitle;
    
    toggleOpenRouter(config.llm?.provider);

    // Update hidden input
    const headerInput = document.querySelector('[name="llm.defaultHeaders"]');
    if (headerInput) headerInput.value = headers ? JSON.stringify(headers) : '';

    // Database
    setVal('database.type', config.database?.type);
    setVal('database.tableName', config.database?.tableName || config.database?.table_name);
    const colMap = config.database?.columnMap || config.database?.column_map;
    setVal('database.columnMap', colMap ? JSON.stringify(colMap, null, 2) : '');

    // Chunking
    setVal('chunking.strategy', config.chunking?.strategy);
    setVal('chunking.chunkSize', config.chunking?.chunkSize || config.chunking?.chunk_size);
    setVal('chunking.chunkOverlap', config.chunking?.chunkOverlap || config.chunking?.chunk_overlap);
    setVal('chunking.separators', config.chunking?.separators ? JSON.stringify(config.chunking.separators) : '');

    // Retrieval
    setVal('retrieval.strategy', config.retrieval?.strategy);
    setVal('retrieval.hybridAlpha', config.retrieval?.hybridAlpha || config.retrieval?.hybrid_alpha);

    // Reranking
    const rerankEnabled = config.reranking?.enabled;
    const cb = document.querySelector('[name="reranking.enabled"]');
    if (cb) cb.checked = !!rerankEnabled;
    
    setVal('reranking.topN', config.reranking?.topN || config.reranking?.top_n);
    setVal('reranking.windowSize', config.reranking?.windowSize || config.reranking?.window_size);

    // Metadata
    const metadataFilters = config.metadata?.filters;
    setVal('metadata.filters', metadataFilters ? JSON.stringify(metadataFilters, null, 2) : '');

    // Query Planning
    setVal('queryPlanning.strategy', config.queryPlanning?.strategy || config.query_planning?.strategy);
    const initialPrompts = config.queryPlanning?.initialPrompts || config.query_planning?.initial_prompts;
    setVal('queryPlanning.initialPrompts', initialPrompts ? JSON.stringify(initialPrompts, null, 2) : '');

    // Grounding
    const groundingEnabled = config.grounding?.enabled;
    const cbGrounding = document.querySelector('[name="grounding.enabled"]');
    if (cbGrounding) cbGrounding.checked = !!groundingEnabled;
    setVal('grounding.threshold', config.grounding?.threshold);

    // Generation
    setVal('generation.style', config.generation?.style);
    setVal('generation.maxLength', config.generation?.maxLength || config.generation?.max_length);

    // Prompts
    setVal('prompts.system', config.prompts?.system);
    setVal('prompts.user', config.prompts?.user);
}

// Fix: Move addHeaderRow to global scope or re-structure
function addHeaderRow(key = '', value = '') {
    const headersBuilder = document.getElementById('headers-builder');
    if (!headersBuilder) return;

    const row = document.createElement('div');
    row.className = 'flex items-center space-x-2 header-row mb-2';
    row.innerHTML = `
        <input type="text" placeholder="Key" value="${key}" class="header-key block w-1/2 rounded-md border-white/10 bg-dark-950 text-white shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm py-2 px-3 border">
        <input type="text" placeholder="Value" value="${value}" class="header-value block w-1/2 rounded-md border-white/10 bg-dark-950 text-white shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm py-2 px-3 border">
        <button type="button" class="remove-header p-2 text-gray-400 hover:text-red-500 transition-colors">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
        </button>
    `;
    
    row.querySelector('.remove-header').addEventListener('click', () => {
        row.remove();
        updateHiddenHeaders();
        document.getElementById('config-form').dispatchEvent(new Event('change'));
    });

    row.querySelectorAll('input').forEach(input => {
        input.addEventListener('input', () => {
            updateHiddenHeaders();
            document.getElementById('config-form').dispatchEvent(new Event('change'));
        });
    });

    headersBuilder.appendChild(row);
}

function updateHiddenHeaders() {
    const headersBuilder = document.getElementById('headers-builder');
    const rows = headersBuilder.querySelectorAll('.header-row');
    const headers = {};
    let hasHeaders = false;

    rows.forEach(row => {
        const key = row.querySelector('.header-key').value.trim();
        const value = row.querySelector('.header-value').value.trim();
        if (key) {
            headers[key] = value;
            hasHeaders = true;
        }
    });

    const input = document.querySelector('[name="llm.defaultHeaders"]');
    if (input) {
        input.value = hasHeaders ? JSON.stringify(headers) : '';
    }
}

function setVal(name, value) {
    const el = document.querySelector(`[name="${name}"]`);
    if (el) {
        el.value = (value === undefined || value === null) ? '' : value;
    }
}

function buildPayload() {
    const formData = new FormData(document.getElementById('config-form'));
    const get = (n) => formData.get(n);
    const getNum = (n) => { const v = get(n); return v ? Number(v) : undefined; };
    const getJson = (n) => { 
        const v = get(n); 
        try { return v ? JSON.parse(v) : undefined; } 
        catch { return undefined; } 
    };
    
    const isPython = isPythonBackend;

    return {
        embedding: {
            provider: get('embedding.provider'),
            [isPython ? 'api_key' : 'apiKey']: get('embedding.apiKey'),
            [isPython ? 'model_name' : 'modelName']: get('embedding.modelName'),
            dimensions: getNum('embedding.dimensions')
        },
        llm: {
            provider: get('llm.provider'),
            [isPython ? 'api_key' : 'apiKey']: get('llm.apiKey'),
            [isPython ? 'model_name' : 'modelName']: get('llm.modelName'),
            temperature: getNum('llm.temperature'),
            [isPython ? 'max_tokens' : 'maxTokens']: getNum('llm.maxTokens'),
            [isPython ? 'base_url' : 'baseUrl']: get('llm.baseUrl') || undefined,
            [isPython ? 'default_headers' : 'defaultHeaders']: getJson('llm.defaultHeaders')
        },
        database: {
            type: get('database.type'),
            [isPython ? 'table_name' : 'tableName']: get('database.tableName'),
            [isPython ? 'column_map' : 'columnMap']: getJson('database.columnMap')
        },
        chunking: {
            strategy: get('chunking.strategy'),
            [isPython ? 'chunk_size' : 'chunkSize']: getNum('chunking.chunkSize'),
            [isPython ? 'chunk_overlap' : 'chunkOverlap']: getNum('chunking.chunkOverlap'),
            separators: getJson('chunking.separators'),
            [isPython ? 'agentic_llm' : 'agenticLlm']: (get('chunking.strategy') === 'agentic') ? {
                provider: get('chunking.agentic.provider'),
                [isPython ? 'api_key' : 'apiKey']: get('chunking.agentic.apiKey'),
                [isPython ? 'model_name' : 'modelName']: get('chunking.agentic.modelName'),
                temperature: getNum('chunking.agentic.temperature'),
                [isPython ? 'max_tokens' : 'maxTokens']: getNum('chunking.agentic.maxTokens'),
                [isPython ? 'base_url' : 'baseUrl']: get('chunking.agentic.baseUrl') || undefined
            } : undefined
        },
        retrieval: {
            strategy: get('retrieval.strategy'),
            [isPython ? 'hybrid_alpha' : 'hybridAlpha']: getNum('retrieval.hybridAlpha'),
            [isPython ? 'mmr_lambda' : 'mmrLambda']: getNum('retrieval.mmrLambda'),
            [isPython ? 'mmr_fetch_k' : 'mmrFetchK']: getNum('retrieval.mmrFetchK'),
            [isPython ? 'llm_config' : 'llmConfig']: (['hyde','multi_query'].includes(get('retrieval.strategy'))) ? {
                provider: get('retrieval.llm.provider'),
                [isPython ? 'api_key' : 'apiKey']: get('retrieval.llm.apiKey'),
                [isPython ? 'model_name' : 'modelName']: get('retrieval.llm.modelName'),
                temperature: getNum('retrieval.llm.temperature'),
                [isPython ? 'max_tokens' : 'maxTokens']: getNum('retrieval.llm.maxTokens'),
                [isPython ? 'base_url' : 'baseUrl']: get('retrieval.llm.baseUrl') || undefined
            } : undefined
        },
        reranking: {
            enabled: document.querySelector('[name="reranking.enabled"]').checked,
            provider: 'llm',
            [isPython ? 'top_n' : 'topN']: getNum('reranking.topN'),
            [isPython ? 'window_size' : 'windowSize']: getNum('reranking.windowSize'),
            [isPython ? 'llm_config' : 'llmConfig']: document.querySelector('[name="reranking.enabled"]').checked ? {
                provider: get('reranking.llm.provider'),
                [isPython ? 'api_key' : 'apiKey']: get('reranking.llm.apiKey'),
                [isPython ? 'model_name' : 'modelName']: get('reranking.llm.modelName'),
                temperature: getNum('reranking.llm.temperature'),
                [isPython ? 'max_tokens' : 'maxTokens']: getNum('reranking.llm.maxTokens'),
                [isPython ? 'base_url' : 'baseUrl']: get('reranking.llm.baseUrl') || undefined
            } : undefined
        },
        metadata: {
            filters: getJson('metadata.filters')
        },
        [isPython ? 'query_planning' : 'queryPlanning']: {
            strategy: get('queryPlanning.strategy'),
            [isPython ? 'initial_prompts' : 'initialPrompts']: getJson('queryPlanning.initialPrompts'),
            [isPython ? 'token_budget' : 'tokenBudget']: getNum('queryPlanning.tokenBudget'),
            [isPython ? 'prefer_summaries_below' : 'preferSummariesBelow']: getNum('queryPlanning.preferSummariesBelow'),
            [isPython ? 'include_citations' : 'includeCitations']: !!document.querySelector('[name="queryPlanning.includeCitations"]').checked
        },
        grounding: {
            enabled: document.querySelector('[name="grounding.enabled"]').checked,
            threshold: getNum('grounding.threshold'),
            strict: !!document.querySelector('[name="grounding.strict"]').checked,
            [isPython ? 'max_snippets' : 'maxSnippets']: getNum('grounding.maxSnippets')
        },
        generation: {
            style: get('generation.style'),
            [isPython ? 'max_length' : 'maxLength']: getNum('generation.maxLength'),
            [isPython ? 'structured_output' : 'structuredOutput']: get('generation.structuredOutput'),
            [isPython ? 'output_format' : 'outputFormat']: get('generation.outputFormat')
        },
        prompts: {
            system: get('prompts.system'),
            user: get('prompts.user')
        }
    };
}

function updatePreview() {
    // We want to highlight the section that is currently active (scrolled to)
    // We construct HTML manually for JS object structure with syntax highlighting.
    
    const payload = buildPayload();
    const previewEl = document.getElementById('json-preview');
    if (!previewEl) return;

    // Get active section from sidebar
    const activeLink = document.querySelector('.nav-item.active');
    const activeSection = activeLink ? activeLink.getAttribute('data-target') : null;

    // Helper to format value with colors
    const formatValue = (val, indentLevel) => {
        if (val === null) return '<span class="text-[#ff7b72]">null</span>';
        if (val === undefined) return '<span class="text-[#79c0ff]">undefined</span>';
        if (typeof val === 'boolean') return `<span class="text-[#79c0ff]">${val}</span>`;
        if (typeof val === 'number') return `<span class="text-[#79c0ff]">${val}</span>`;
        if (typeof val === 'string') return `<span class="text-[#a5d6ff]">'${val}'</span>`;
        if (Array.isArray(val)) {
            if (val.length === 0) return '[]';
            const indent = '  '.repeat(indentLevel);
            const nextIndent = '  '.repeat(indentLevel + 1);
            const items = val.map(v => `${nextIndent}${formatValue(v, indentLevel + 1)}`).join(',\n');
            return `[\n${items}\n${indent}]`;
        }
        if (typeof val === 'object') {
            if (Object.keys(val).length === 0) return '{}';
            const indent = '  '.repeat(indentLevel);
            const nextIndent = '  '.repeat(indentLevel + 1);
            const props = Object.entries(val).map(([k, v]) => {
                // Key color (light blue usually in VS Code for properties, or similar)
                // Using a distinct color for keys: text-[#d2a8ff] (purple-ish) or text-[#7ee787] (green-ish)
                // VS Code Default Dark+ Properties are light blue.
                const keyStr = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k) ? k : `'${k}'`;
                return `\n${nextIndent}<span class="text-[#7ee787]">${keyStr}</span>: ${formatValue(v, indentLevel + 1)}`;
            }).join(',');
            return `{${props}\n${indent}}`;
        }
        return String(val);
    };

    // Helper to wrap a section
    const jsPart = (key, data, sectionId) => {
        // Format the object body (level 1 indent)
        const valStr = formatValue(data, 1);
        const isActive = (sectionId === activeSection);
        // Active: slight background, full opacity. Inactive: dimmed.
        // We use 'group' to handle hover effects if needed, but here just static state.
        const className = isActive 
            ? 'json-section json-active bg-[#2d2d2d] rounded border-l-2 border-[#58a6ff]' 
            : 'json-section json-dimmed border-l-2 border-transparent';
        
        return `<pre class="${className} p-2 pl-3 whitespace-pre leading-5"><span class="text-[#7ee787]">${key}</span>: ${valStr}</pre>`;
    };

    const isToggleOn = (name) => {
        const el = document.querySelector(`[name="toggle.${name}"]`);
        return el ? el.checked : false;
    };

    let html = '';
    if (!isPythonBackend) {
        html += '<span class="text-[#ff7b72]">const</span> <span class="text-[#d2a8ff]">config</span> = {\n';
    } else {
        html += '<span class="text-[#d2a8ff]">config</span> <span class="text-[#79c0ff]">=</span> {\n';
    }

    const parts = [];
    parts.push(jsPart('embedding', payload.embedding, 'embedding'));
    parts.push(jsPart('llm', payload.llm, 'llm'));
    parts.push(jsPart('database', payload.database, 'database'));
    parts.push(jsPart('chunking', payload.chunking, 'chunking'));
    parts.push(jsPart('reranking', payload.reranking, 'reranking'));
    if (isToggleOn('retrieval')) parts.push(jsPart('retrieval', payload.retrieval, 'retrieval'));
    if (isToggleOn('metadata')) parts.push(jsPart('metadata', payload.metadata, 'metadata'));
    const qpKey = isPythonBackend ? 'query_planning' : 'queryPlanning';
    if (isToggleOn('queryPlanning')) parts.push(jsPart(qpKey, payload[qpKey], 'query-planning'));
    if (isToggleOn('grounding')) parts.push(jsPart('grounding', payload.grounding, 'grounding'));
    if (isToggleOn('generation')) parts.push(jsPart('generation', payload.generation, 'generation'));
    if (isToggleOn('prompts')) parts.push(jsPart('prompts', payload.prompts, 'prompts'));

    html += parts.join(',\n');
    html += '\n}';
    if (!isPythonBackend) {
        html += '\n\n<span class="text-[#ff7b72]">module</span>.<span class="text-[#d2a8ff]">exports</span> = <span class="text-[#d2a8ff]">config</span>';
    }

    previewEl.innerHTML = html;
}

// Wrapper for updatePreviewHighlight to be called from scroll spy
function updatePreviewHighlight(activeSectionId) {
    // Re-render the preview to apply classes
    // Note: This might be expensive on every scroll event if the payload is huge, 
    // but for this config size it's fine.
    // Optimization: Just toggle classes on existing DOM elements if possible.
    // But since we regenerate HTML in updatePreview, let's just call that.
    updatePreview();
}

async function saveConfig(e) {
    e.preventDefault();
    const btn = document.getElementById('save-btn');
    const originalText = btn.innerText;
    btn.innerText = 'Saving...';
    btn.disabled = true;
    btn.classList.add('opacity-75', 'cursor-not-allowed');

    try {
        const payload = buildPayload();

        const isToggleOn = (name) => {
            const el = document.querySelector(`[name="toggle.${name}"]`);
            return el ? el.checked : false;
        };

        const cfg = {
            embedding: payload.embedding,
            llm: payload.llm,
            database: payload.database,
            chunking: payload.chunking,
            reranking: payload.reranking
        };
        if (isToggleOn('retrieval')) cfg.retrieval = payload.retrieval;
        if (isToggleOn('metadata')) cfg.metadata = payload.metadata;
        const qpKey = isPythonBackend ? 'query_planning' : 'queryPlanning';
        if (isToggleOn('queryPlanning')) cfg[qpKey] = payload[qpKey];
        if (isToggleOn('grounding')) cfg.grounding = payload.grounding;
        if (isToggleOn('generation')) cfg.generation = payload.generation;
        if (isToggleOn('prompts')) cfg.prompts = payload.prompts;

        const cleanCfg = JSON.parse(JSON.stringify(cfg));

        let code = '';
        if (!isPythonBackend) {
            code = `const config = ${JSON.stringify(cleanCfg, null, 2)};\nmodule.exports = config;`;
        } else {
            let py = JSON.stringify(cleanCfg, null, 2);
            py = py.replace(/true/g, 'True').replace(/false/g, 'False').replace(/null/g, 'None');
            py = py.replace(/"/g, "'");
            code = `config = ${py}`;
        }

        const res = await fetch('/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ backend: isPythonBackend ? 'python' : 'node', code, config: cleanCfg })
        });

        const data = await res.json();
        
        if (res.ok) {
            showStatus('Saved successfully!', 'success');
        } else {
            throw new Error(data.error || 'Unknown error');
        }

    } catch (e) {
        showStatus(e.message, 'error');
    } finally {
        btn.innerText = originalText;
        btn.disabled = false;
        btn.classList.remove('opacity-75', 'cursor-not-allowed');
    }
}

function showStatus(msg, type) {
    const el = document.getElementById('status-msg');
    el.textContent = msg;
    
    if (type === 'success') {
        el.className = 'text-sm font-medium transition-colors duration-300 text-green-600';
    } else {
        el.className = 'text-sm font-medium transition-colors duration-300 text-red-600';
    }
    
    setTimeout(() => {
        el.textContent = '';
    }, 3000);
}
