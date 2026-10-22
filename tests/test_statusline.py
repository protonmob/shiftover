from shiftover import statusline


def test_wrapped_command_timeout_is_contained():
    import time
    t0 = time.time()
    assert statusline._wrapped("sleep 30 | cat", "{}") == ""
    assert time.time() - t0 < 6


def test_wrapped_output_survives_bad_bytes_and_failures():
    assert statusline._wrapped("printf 'ok\\xff\\n'", "{}") == "ok\ufffd"
    assert statusline._wrapped("exit 3", "{}") == ""
    assert statusline._wrapped("", "{}") == ""
