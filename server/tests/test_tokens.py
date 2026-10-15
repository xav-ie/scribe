"""The real StreamState's token-to-word assembly, with a toy tokenizer."""

import pytest
import stream_server as srv

RealState = srv.StreamState
VOCAB = ["▁", "▁hel", "lo", "▁world", "s", "▁a", "b"]


class Tokenizer:
    def ids_to_tokens(self, ids):
        return [VOCAB[i] for i in ids]

    def ids_to_text(self, ids):
        return "".join(VOCAB[i] for i in ids).replace("▁", " ").strip()


@pytest.fixture
def state(monkeypatch):
    monkeypatch.setattr(srv.model, "tokenizer", Tokenizer(), raising=False)
    monkeypatch.setattr(srv, "FRAME_S", 0.08)
    monkeypatch.setattr(srv, "TS_OFFSET_S", 0.29)
    s = object.__new__(RealState)
    s.words, s.word_ids, s.boundary = [], [], False
    return s


def ids(*pieces):
    return [VOCAB.index(p) for p in pieces]


def test_pieces_join_into_words(state):
    state._add_tokens(ids("▁hel", "lo", "▁world", "s"), [10, 11, 20, 21])
    assert state.words == [
        {"word": "hello", "start": 0.51, "end": 0.67},
        {"word": "worlds", "start": 1.31, "end": 1.47},
    ]


def test_a_word_split_across_steps_keeps_growing(state):
    state._add_tokens(ids("▁hel"), [10])
    assert [w["word"] for w in state.words] == ["hel"]
    state._add_tokens(ids("lo", "▁a"), [11, 15])
    assert [w["word"] for w in state.words] == ["hello", "a"]
    assert state.words[0]["end"] == 0.67


def test_a_bare_boundary_starts_the_next_word(state):
    state._add_tokens(ids("▁a", "▁"), [1, 2])
    state._add_tokens(ids("b"), [3])
    assert [w["word"] for w in state.words] == ["a", "b"]


def test_the_first_piece_always_starts_a_word(state):
    state._add_tokens(ids("lo"), [0])
    assert state.words == [{"word": "lo", "start": 0.0, "end": 0.0}]
