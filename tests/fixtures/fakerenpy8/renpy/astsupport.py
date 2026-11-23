class PyExpr(str):
    """Ren'Py 8.x: pickled via __reduce__ with six args."""
    __slots__ = ['filename', 'linenumber', 'py', 'hashcode', 'column']

    def __new__(cls, s, filename='game/script.rpy', linenumber=1, py=3, hashcode=0, column=0):
        self = str.__new__(cls, s)
        self.filename, self.linenumber, self.py, self.hashcode, self.column = filename, linenumber, py, hashcode, column
        return self

    def __reduce__(self):
        return (PyExpr, (str(self), self.filename, self.linenumber, self.py, self.hashcode, self.column))
