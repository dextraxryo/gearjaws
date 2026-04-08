-- ═══════════════════════════════════════════════════════════════
-- GearJaws (機材屋ジョーズ) Supabase スキーマ
-- バージョン: v0.3 (Session C)
-- Supabase SQL Editor に貼り付けて実行してください
-- ═══════════════════════════════════════════════════════════════

-- UUID 拡張（Supabase ではデフォルト有効）
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ───────────────────────────────────────────────
-- 1. products テーブル（収録機材マスタ）
-- ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,                          -- 正規名: "Neve 1073"
  aliases         TEXT[] DEFAULT '{}',                    -- 別名: ['neve1073','1073']
  category        TEXT CHECK (category IN (
                    'preamp','compressor','microphone',
                    'eq','reverb','other'
                  )),
  manufacturer    TEXT,                                   -- "Neve", "Neumann"
  description_ja  TEXT,
  description_en  TEXT,
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- updated_at 自動更新トリガー
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER products_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- β版 6機材の初期データ
INSERT INTO products (name, aliases, category, manufacturer) VALUES
  ('Neve 1073',         ARRAY['neve1073','neve','1073','neve 1073'],        'preamp',      'Neve'),
  ('Neumann U87',       ARRAY['u87','neumann u87','u-87','u87ai'],          'microphone',  'Neumann'),
  ('UA 1176',           ARRAY['1176','ua1176','universal audio 1176'],       'compressor',  'Universal Audio'),
  ('SSL G-Bus',         ARRAY['ssl gbus','g-bus','ssl bus compressor'],      'compressor',  'SSL'),
  ('API 2500',          ARRAY['api2500','api 2500','2500'],                  'compressor',  'API'),
  ('Eventide H3000',    ARRAY['h3000','eventide h3000','harmonizer h3000'],  'reverb',      'Eventide')
ON CONFLICT DO NOTHING;

-- ───────────────────────────────────────────────
-- 2. listings テーブル（売買実績データ）
-- ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS listings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id    UUID REFERENCES products(id) ON DELETE SET NULL,
  platform      TEXT NOT NULL,             -- 'reverb' | 'ebay' | 'yahooauctions' | etc
  title         TEXT NOT NULL,
  price         NUMERIC,                   -- 元通貨の価格
  price_jpy     INTEGER,
  price_usd     NUMERIC,
  currency      CHAR(3),                   -- 'JPY' | 'USD'
  condition     TEXT,                      -- '新品同様' | '良好' | '普通' | 'ジャンク'
  status        TEXT CHECK (status IN ('sold','listing','ended')),
  listing_date  DATE,
  url           TEXT,
  image_url     TEXT,
  scraped_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (url, listing_date)               -- 同一出品の重複防止
);

-- インデックス
CREATE INDEX IF NOT EXISTS listings_product_id_idx  ON listings(product_id);
CREATE INDEX IF NOT EXISTS listings_platform_idx     ON listings(platform);
CREATE INDEX IF NOT EXISTS listings_listing_date_idx ON listings(listing_date DESC);
CREATE INDEX IF NOT EXISTS listings_price_jpy_idx    ON listings(price_jpy);

-- ───────────────────────────────────────────────
-- 3. search_logs テーブル（検索ログ）
-- ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS search_logs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query               TEXT NOT NULL,
  normalized_query    TEXT,
  matched_product_id  UUID REFERENCES products(id) ON DELETE SET NULL,
  result_count        INTEGER DEFAULT 0,
  data_source         TEXT,               -- 'reverb_api' | 'mock_db' | 'no_match'
  platforms_searched  TEXT[] DEFAULT '{}',
  lang                CHAR(2) DEFAULT 'ja',
  ip_country          CHAR(2),
  user_agent_hash     CHAR(16),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- インデックス（分析クエリ用）
CREATE INDEX IF NOT EXISTS search_logs_query_idx      ON search_logs(query);
CREATE INDEX IF NOT EXISTS search_logs_created_at_idx ON search_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS search_logs_data_source_idx ON search_logs(data_source);

-- ───────────────────────────────────────────────
-- 4. alerts テーブル（価格アラート・v1.5〜）
-- ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alerts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID,                         -- v1.5〜 Supabase Auth連携
  email             TEXT NOT NULL,
  product_id        UUID REFERENCES products(id) ON DELETE CASCADE,
  max_price_jpy     INTEGER,                      -- NULL = 価格問わず新着通知
  condition_min     TEXT,
  active            BOOLEAN NOT NULL DEFAULT true,
  last_notified_at  TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ───────────────────────────────────────────────
-- 5. Row Level Security (RLS)
-- ───────────────────────────────────────────────
-- products: 全員読み取り可、書き込みは service_role のみ
ALTER TABLE products    ENABLE ROW LEVEL SECURITY;
ALTER TABLE listings    ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts      ENABLE ROW LEVEL SECURITY;

CREATE POLICY "products_public_read"    ON products    FOR SELECT USING (true);
CREATE POLICY "listings_public_read"    ON listings    FOR SELECT USING (true);
-- search_logs / alerts は anon からの INSERT のみ許可（SELECT は service_role のみ）
CREATE POLICY "search_logs_anon_insert" ON search_logs FOR INSERT WITH CHECK (true);
CREATE POLICY "alerts_anon_insert"      ON alerts      FOR INSERT WITH CHECK (true);

-- ───────────────────────────────────────────────
-- 6. 便利ビュー（分析用）
-- ───────────────────────────────────────────────
-- 人気検索キーワード TOP20
CREATE OR REPLACE VIEW popular_queries AS
  SELECT query, COUNT(*) AS search_count,
         MAX(created_at) AS last_searched_at
  FROM search_logs
  GROUP BY query
  ORDER BY search_count DESC
  LIMIT 20;

-- 未収録クエリ一覧（matched_product_id が NULL）
CREATE OR REPLACE VIEW uncovered_queries AS
  SELECT query, COUNT(*) AS search_count
  FROM search_logs
  WHERE matched_product_id IS NULL
    AND data_source = 'no_match'
  GROUP BY query
  ORDER BY search_count DESC;
