-- 1. 新增用戶表
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- 2. 修改 notes 表 (建議清空舊資料或手動添加欄位)
-- 若要保留資料，請執行: ALTER TABLE notes ADD COLUMN user_id INTEGER DEFAULT 1;
DROP TABLE IF EXISTS notes;
CREATE TABLE notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL, -- 關鍵：關聯用戶
  content TEXT NOT NULL,
  files TEXT DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  is_pinned BOOLEAN DEFAULT 0,
  is_favorited INTEGER DEFAULT 0 NOT NULL,
  is_archived INTEGER DEFAULT 0 NOT NULL,
  pics TEXT,
  videos TEXT DEFAULT '[]',
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 3. 修改 tags 表也與用戶綁定
DROP TABLE IF EXISTS tags;
CREATE TABLE tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  UNIQUE(user_id, name),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
