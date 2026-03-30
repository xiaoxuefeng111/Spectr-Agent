-- ClaudeOps SQLite Schema
-- @author weibin

-- 任务表
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled')),
  priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low', 'medium', 'high', 'urgent')),
  tags TEXT, -- JSON array
  parent_task_id TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  FOREIGN KEY (parent_task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);

-- 会话表
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  name TEXT NOT NULL,
  working_directory TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'waiting', 'completed', 'error')),
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at DATETIME,
  exit_code INTEGER,
  estimated_tokens INTEGER NOT NULL DEFAULT 0,
  config TEXT NOT NULL, -- JSON
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_task_id ON sessions(task_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at);

-- 活动事件表
CREATE TABLE IF NOT EXISTS activity_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  type TEXT NOT NULL CHECK(type IN ('session_start', 'session_end', 'user_input', 'user_action', 'tool_execution', 'intervention_needed', 'error', 'warning')),
  detail TEXT NOT NULL,
  metadata TEXT, -- JSON
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_activity_session_id ON activity_events(session_id);
CREATE INDEX IF NOT EXISTS idx_activity_timestamp ON activity_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_activity_type ON activity_events(type);

-- 会话日志表
CREATE TABLE IF NOT EXISTS session_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  chunk TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_logs_session_id ON session_logs(session_id);
CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON session_logs(timestamp);

-- 全文搜索虚拟表（用于日志搜索）
CREATE VIRTUAL TABLE IF NOT EXISTS session_logs_fts USING fts5(
  session_id UNINDEXED,
  chunk,
  content='session_logs',
  content_rowid='id'
);

-- 触发器：同步日志到全文搜索表
CREATE TRIGGER IF NOT EXISTS session_logs_ai AFTER INSERT ON session_logs BEGIN
  INSERT INTO session_logs_fts(rowid, session_id, chunk)
  VALUES (new.id, new.session_id, new.chunk);
END;

CREATE TRIGGER IF NOT EXISTS session_logs_ad AFTER DELETE ON session_logs BEGIN
  DELETE FROM session_logs_fts WHERE rowid = old.id;
END;

CREATE TRIGGER IF NOT EXISTS session_logs_au AFTER UPDATE ON session_logs BEGIN
  DELETE FROM session_logs_fts WHERE rowid = old.id;
  INSERT INTO session_logs_fts(rowid, session_id, chunk)
  VALUES (new.id, new.session_id, new.chunk);
END;

-- 工作流表
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  definition TEXT NOT NULL, -- JSON: { steps: [...], variables: {...} }
  is_template INTEGER NOT NULL DEFAULT 0, -- 0=false, 1=true
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_workflows_is_template ON workflows(is_template);
CREATE INDEX IF NOT EXISTS idx_workflows_created_at ON workflows(created_at);

-- 工作流执行表
CREATE TABLE IF NOT EXISTS workflow_executions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  variables TEXT, -- JSON: runtime variables
  step_statuses TEXT, -- JSON: { stepId: status }
  step_outputs TEXT, -- JSON: { stepId: output }
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workflow_executions_workflow_id ON workflow_executions(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_executions_status ON workflow_executions(status);
CREATE INDEX IF NOT EXISTS idx_workflow_executions_started_at ON workflow_executions(started_at);

-- 使用统计表
CREATE TABLE IF NOT EXISTS usage_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  date DATE NOT NULL,
  estimated_tokens INTEGER NOT NULL DEFAULT 0,
  active_minutes INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_stats_date ON usage_stats(date);
CREATE INDEX IF NOT EXISTS idx_usage_stats_session_id ON usage_stats(session_id);

-- 触发器：自动更新 updated_at
CREATE TRIGGER IF NOT EXISTS tasks_updated_at AFTER UPDATE ON tasks BEGIN
  UPDATE tasks SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS workflows_updated_at AFTER UPDATE ON workflows BEGIN
  UPDATE workflows SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;
