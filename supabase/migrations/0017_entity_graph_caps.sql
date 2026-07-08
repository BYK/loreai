-- Migration 0017: raise the free-tier entity-graph row caps
--
-- The original free caps (0003) sized the entity graph at entities=30 against
-- knowledge=500 — far too tight. A real 500-entry knowledge base extracts ~100-300
-- entities, so at 30 the graph that makes knowledge navigable is mostly evicted (a
-- user with 115 entities synced only 30, and the refs/aliases to the other ~85 became
-- orphans skipped on pull). Entities are cheap (~200 B/row), so keep the *content*
-- cap (knowledge=500) as the real free-tier limit and let the graph be proportionate.
--
--   entities              30 ->  300   (~proportionate to knowledge=500)
--   entity_aliases       300 -> 3000   (~10x entities)
--   entity_relations     300 -> 1500
--   knowledge_entity_refs 2000 -> 5000  (~10 refs/entity)
--
-- Row caps only. The free-tier byte caps (0007: entities 1 MB, aliases/relations 2 MB,
-- refs 1 MB) already hold the new row counts with headroom (e.g. 3000 aliases ~= 450 KB
-- << 2 MB), so they stay as the anti-abuse backstop and won't surprise-bind before the
-- row cap. Pro tier unchanged. Idempotent (plain UPDATE of existing rows).

update public.plan_limits set max_rows = v.max_rows
  from (values
    ('entities',               300),
    ('entity_aliases',        3000),
    ('entity_relations',      1500),
    ('knowledge_entity_refs', 5000)
  ) as v(table_name, max_rows)
 where public.plan_limits.tier = 'free'
   and public.plan_limits.table_name = v.table_name;
