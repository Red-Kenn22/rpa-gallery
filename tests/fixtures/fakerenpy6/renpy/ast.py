"""Ren'Py 6-shaped AST: plain __dict__ objects, 3-element imspec, Py2-era PyCode state."""
class Object(object):
    def __init__(self, **kw): self.__dict__.update(kw)

class PyCode(Object):
    def __getstate__(self): return (1, self.source, self.location, self.mode)
    def __setstate__(self, s): pass

class Node(Object): pass
class Say(Node): pass
class Label(Node): pass
class Scene(Node): pass
class Show(Node): pass
class Init(Node): pass
class Define(Node): pass
