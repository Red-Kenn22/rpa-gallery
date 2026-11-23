"""Stand-ins mirroring Ren'Py's revertable containers' pickling behaviour."""
class RevertableList(list):
    pass

class RevertableDict(dict):
    pass

class RevertableSet(set):
    def __setstate__(self, state):
        if isinstance(state, tuple):
            self.update(state[0].keys())
        else:
            self.update(state)

    def __getstate__(self):
        return ({i: True for i in self},)

class RevertableObject(object):
    pass
