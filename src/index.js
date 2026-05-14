const NOTES_PER_PAGE = 10;
const SESSION_DURATION_SECONDS = 30 * 86400; // 30 天
const SESSION_COOKIE = '__session';

export default {
    async fetch(request, env, ctx) {
        return await handleApiRequest(request, env);
    },
};

async function handleApiRequest(request, env) {
    const { pathname } = new URL(request.url);

    // --- 公開路由 (不需要登入) ---
    const sharePageMatch = pathname.match(/^\/share\/([a-zA-Z0-9-]+)$/);
    if (sharePageMatch) {
        const targetUrl = new URL('/share.html', request.url);
        targetUrl.searchParams.set('id', sharePageMatch[1]);
        return Response.redirect(targetUrl.toString(), 302);
    }

    if (pathname.startsWith('/api/public/')) return handlePublicRequests(pathname, env, request);
    if (pathname.startsWith('/api/tg-media-proxy/')) return handleTelegramProxy(request, env);
    
    // Telegram Webhook (透過 Secret 驗證)
    const telegramMatch = pathname.match(/^\/api\/telegram_webhook\/([^\/]+)$/);
    if (request.method === 'POST' && telegramMatch) {
        return handleTelegramWebhook(request, env, telegramMatch[1]);
    }

    // 登入介面
    if (request.method === 'POST' && pathname === '/api/login') return handleLogin(request, env);
    if (request.method === 'POST' && pathname === '/api/logout') return handleLogout(request, env);

    // --- 身份驗證攔截器 ---
    const session = await isSessionAuthenticated(request, env);
    if (!session) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
    }
    const userId = session.userId; // 取得目前登入者的 ID

    // --- 私有路由 (全部傳入 userId 以實現數據隔離) ---
    if (pathname === '/api/stats') return handleStatsRequest(request, env, userId);
    if (pathname === '/api/tags') return handleTagsList(request, env, userId);
    if (pathname === '/api/notes/timeline') return handleTimelineRequest(request, env, userId);
    if (pathname === '/api/search') return handleSearchRequest(request, env, userId);
    if (pathname === '/api/notes') return handleNotesList(request, env, userId);
    
    const noteDetailMatch = pathname.match(/^\/api\/notes\/([^\/]+)$/);
    if (noteDetailMatch) return handleNoteDetail(request, noteDetailMatch[1], env, userId);

    // 設定檔 (改為每個用戶獨立儲存於 KV)
    if (pathname === '/api/settings') {
        return request.method === 'GET' ? handleGetSettings(env, userId) : handleSetSettings(request, env, userId);
    }

    return new Response('Not Found', { status: 404 });
}

/**
 * 核心：多用戶登入邏輯
 */
async function handleLogin(request, env) {
    try {
        const { username, password } = await request.json();
        const db = env.DB;
        
        // 從資料庫校驗用戶
        const user = await db.prepare("SELECT id, username FROM users WHERE username = ? AND password = ?")
            .bind(username, password)
            .first();

        if (user) {
            const sessionId = crypto.randomUUID();
            const sessionData = { userId: user.id, username: user.username, loggedInAt: Date.now() };
            
            await env.NOTES_KV.put(`session:${sessionId}`, JSON.stringify(sessionData), {
                expirationTtl: SESSION_DURATION_SECONDS,
            });

            const headers = new Headers();
            // 注意：Path=/ 確保全站可用
            headers.append('Set-Cookie', `${SESSION_COOKIE}=${sessionId}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_DURATION_SECONDS}`);
            return jsonResponse({ success: true }, 200, headers);
        }
    } catch (e) {
        console.error("Login Error:", e.message);
    }
    return jsonResponse({ error: '帳號或密碼錯誤' }, 401);
}

/**
 * 修改後的筆記列表：只查詢屬於自己的筆記
 */
async function handleNotesList(request, env, userId) {
    const db = env.DB;
    try {
        if (request.method === 'GET') {
            const url = new URL(request.url);
            const page = parseInt(url.searchParams.get('page') || '1');
            const offset = (page - 1) * NOTES_PER_PAGE;
            
            const isFavoritesMode = url.searchParams.get('favorites') === 'true';
            const isArchivedMode = url.searchParams.get('archived') === 'true';
            const tagName = url.searchParams.get('tag');

            let whereClauses = ["n.user_id = ?"];
            let bindings = [userId];

            if (isArchivedMode) whereClauses.push("n.is_archived = 1");
            else whereClauses.push("n.is_archived = 0");

            if (isFavoritesMode) whereClauses.push("n.is_favorited = 1");

            let joinClause = "";
            if (tagName) {
                joinClause = `JOIN note_tags nt ON n.id = nt.note_id JOIN tags t ON nt.tag_id = t.id`;
                whereClauses.push("t.name = ?");
                bindings.push(tagName);
            }

            const query = `
                SELECT n.* FROM notes n ${joinClause}
                WHERE ${whereClauses.join(" AND ")}
                ORDER BY n.is_pinned DESC, n.updated_at DESC
                LIMIT ? OFFSET ?
            `;
            bindings.push(NOTES_PER_PAGE + 1, offset);

            const { results: notesPlusOne } = await db.prepare(query).bind(...bindings).all();
            const hasMore = notesPlusOne.length > NOTES_PER_PAGE;
            const notes = notesPlusOne.slice(0, NOTES_PER_PAGE).map(n => ({
                ...n,
                files: typeof n.files === 'string' ? JSON.parse(n.files) : []
            }));

            return jsonResponse({ notes, hasMore });

        } else if (request.method === 'POST') {
            // 新增筆記時強制寫入當前 userId
            const formData = await request.formData();
            const content = formData.get('content')?.toString() || '';
            const now = Date.now();
            
            const insertStmt = db.prepare(
                "INSERT INTO notes (user_id, content, files, is_pinned, created_at, updated_at) VALUES (?, ?, '[]', 0, ?, ?) RETURNING id"
            );
            const { id: noteId } = await insertStmt.bind(userId, content, now, now).first();
            
            const newNote = await db.prepare("SELECT * FROM notes WHERE id = ?").bind(noteId).first();
            return jsonResponse(newNote, 201);
        }
    } catch (e) {
        return jsonResponse({ error: e.message }, 500);
    }
}

/**
 * 修改後的統計數據：只計算自己的
 */
async function handleStatsRequest(request, env, userId) {
    const db = env.DB;
    const [memos, tags, oldest] = await Promise.all([
        db.prepare("SELECT COUNT(*) as total FROM notes WHERE user_id = ?").bind(userId).first(),
        db.prepare("SELECT COUNT(DISTINCT tag_id) as total FROM note_tags nt JOIN notes n ON nt.note_id = n.id WHERE n.user_id = ?").bind(userId).first(),
        db.prepare("SELECT MIN(updated_at) as oldest_ts FROM notes WHERE user_id = ?").bind(userId).first()
    ]);
    return jsonResponse({ memos: memos.total, tags: tags.total, oldestNoteTimestamp: oldest.oldest_ts });
}

/**
 * 修改後的搜尋：FTS 結合 UserID 隔離
 */
async function handleSearchRequest(request, env, userId) {
    const { searchParams } = new URL(request.url);
    const query = searchParams.get('q') || '';
    const db = env.DB;
    
    const escapedQuery = `"${query.replace(/"/g, '""')}"*`;
    const stmt = db.prepare(`
        SELECT n.* FROM notes n
        JOIN notes_fts fts ON n.id = fts.rowid
        WHERE fts.content MATCH ? AND n.user_id = ?
        ORDER BY rank LIMIT 20
    `);
    const { results } = await stmt.bind(escapedQuery, userId).all();
    return jsonResponse({ notes: results, hasMore: false });
}

// --- 輔助函數 ---

async function isSessionAuthenticated(request, env) {
    const cookieHeader = request.headers.get('Cookie') || '';
    const match = cookieHeader.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
    if (!match) return null;
    return await env.NOTES_KV.get(`session:${match[1]}`, 'json');
}

async function handleLogout(request, env) {
    const cookieHeader = request.headers.get('Cookie') || '';
    const sessionId = cookieHeader.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))?.[1];
    if (sessionId) await env.NOTES_KV.delete(`session:${sessionId}`);
    return jsonResponse({ success: true }, 200, {
        'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`
    });
}

async function handleGetSettings(env, userId) {
    // 每個用戶的設定存在不同的 KV Key
    const settings = await env.NOTES_KV.get(`settings:${userId}`, 'json') || { showSearchBar: true };
    return jsonResponse(settings);
}

async function handleSetSettings(request, env, userId) {
    const body = await request.json();
    await env.NOTES_KV.put(`settings:${userId}`, JSON.stringify(body));
    return jsonResponse({ success: true });
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...extraHeaders }
    });
}

// ... 這裡保留你原本的 handleNoteDetail, handleTagsList 等函數，
// ... 但要在內部所有 SQL 語句中加入 "AND user_id = ?" 並綁定 userId。
