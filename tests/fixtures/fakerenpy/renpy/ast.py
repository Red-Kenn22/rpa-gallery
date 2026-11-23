"""Stand-ins mirroring renpy.ast node pickling (slots, PyExpr, PyCode)."""
class PyExpr(str):
    __slots__ = ['filename', 'linenumber']

    def __new__(cls, s, filename, linenumber):
        self = str.__new__(cls, s)
        self.filename = filename
        self.linenumber = linenumber
        return self

    def __getnewargs__(self):
        return (str(self), self.filename, self.linenumber)

class PyCode(object):
    __slots__ = ['source', 'location', 'mode', 'bytecode', 'hash', 'py']

    def __init__(self, source, loc=('game.rpy', 1), mode='exec'):
        self.source = source; self.location = loc; self.mode = mode; self.py = 3

    def __getstate__(self):
        return (1, self.source, self.location, self.mode, self.py)

    def __setstate__(self, state):
        (_, self.source, self.location, self.mode, self.py) = state

class Node(object):
    __slots__ = ['name', 'filename', 'linenumber', 'next']

    def __init__(self, loc):
        self.filename, self.linenumber = loc
        self.name = None
        self.next = None

class Say(Node):
    __slots__ = ['who', 'what', 'with_', 'attributes']

class Label(Node):
    __slots__ = ['block', 'parameters', 'hide']

class Scene(Node):
    __slots__ = ['imspec', 'layer', 'atl']

class Image(Node):
    __slots__ = ['imgname', 'code', 'atl']

class Define(Node):
    __slots__ = ['varname', 'code', 'store', 'operator', 'index']

class DictNode(object):
    """Old-style renpy.object.Object: state is a plain __dict__."""
    def __init__(self, **kw):
        self.__dict__.update(kw)
