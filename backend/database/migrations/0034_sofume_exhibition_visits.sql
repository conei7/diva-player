CREATE TABLE public.sofume_exhibition_visits (
    visit_day DATE NOT NULL CHECK (visit_day IN (DATE '2026-11-21', DATE '2026-11-22')),
    visit_id UUID NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 10000),
    PRIMARY KEY (visit_day, visit_id),
    UNIQUE (visit_day, ordinal)
);

REVOKE ALL ON TABLE public.sofume_exhibition_visits
    FROM PUBLIC, diva_api_runtime, diva_pipeline_runtime;
GRANT SELECT, INSERT ON TABLE public.sofume_exhibition_visits TO diva_api_runtime;
