from shiftover import usage


def test_parse_limits_new_shape():
    data = {"limits": [
        {"kind": "weekly_scoped", "percent": 40, "resets_at": "2026-10-23T00:00:00Z", "scope": {"model": {"display_name": "Fable"}}},
        {"kind": "session", "percent": 12.5, "resets_at": "2026-10-22T18:00:00Z"},
        {"kind": "weekly_all", "percent": 100, "resets_at": None},
        {"kind": "bogus", "percent": 1},
    ]}
    lims = usage.parse_limits(data)
    assert [x["kind"] for x in lims] == ["session", "weekly_all", "weekly_scoped"]
    assert lims[2]["model"] == "Fable"
    assert usage.blocking(lims) and usage.blocking(lims)[0]["kind"] == "weekly_all"


def test_parse_limits_legacy_shape():
    lims = usage.parse_limits({"five_hour": {"utilization": 3, "resets_at": None}, "seven_day": {"utilization": 50}})
    assert [(x["kind"], x["used"]) for x in lims] == [("session", 3.0), ("weekly_all", 50.0)]


def test_headroom_is_model_aware():
    lims = [{"kind": "session", "model": "", "used": 10, "resets_at": None},
            {"kind": "weekly_scoped", "model": "Fable", "used": 95, "resets_at": None}]
    assert usage.headroom(lims) == 90
    assert usage.headroom(lims, "fable") == 5
    assert usage.headroom(lims, "sonnet") == 90
    assert usage.model_family("claude-fable-5-1") == "fable"
    assert usage.model_family("Opus") == "opus"
    assert usage.model_family(None) is None
