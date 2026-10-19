from studiodesk.names import find_forbidden, is_forbidden


def test_real_names_are_caught_whole_word_and_without_accents():
    assert is_forbidden("Kylian Mbappé scores")
    assert is_forbidden("a run down the wing at ANFIELD")
    assert find_forbidden("Harry Kane and Erling Haaland") == ["harry kane", "erling haaland"]


def test_typography_cannot_hide_a_name():
    for text in ("dell\u2019Arsenal", "Trent Alexander\u2013Arnold", "St James\u2019 Park", "Martin \u00d8degaard",
                 "Harry  Kane", "Harry\nKane", "Son Heung\u2011min"):
        assert is_forbidden(text), text


def test_invented_names_and_partial_words_pass():
    assert not is_forbidden("Harbour Vale Rovers")
    assert not is_forbidden("Arsenalista")  # whole words only
    assert not is_forbidden("Villa Nova Athletic")  # "Aston Villa" is listed, "Villa" alone is not


def test_homoglyphs_accents_and_bare_surnames_are_caught():
    # Cyrillic a, Greek capital eta, accents, a full-width H
    for text in ("Harry Kаne", "Ηarry Kane", "Hárry Käne", "Ｈarry Kane"):
        assert is_forbidden(text), text
    assert is_forbidden("a run from Petrov") and is_forbidden("ADEYEMI again")  # listed as bare surnames
    assert not is_forbidden("Hugo Okowande")
