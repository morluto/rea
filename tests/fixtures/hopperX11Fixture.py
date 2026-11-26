"""X11 window lookups for the Hopper dialog fixtures."""


class FakeX11:
    def __init__(self, titles, transients) -> None:
        self.titles = titles
        self.transients = transients

    def XFetchName(self, _display, window, target):
        value = self.titles.get(window)
        if value is None:
            return 0
        target._obj.value = value.encode("utf-8")
        return 1

    def XGetTransientForHint(self, _display, window, target):
        value = self.transients.get(window)
        if value is None:
            return 0
        target._obj.value = value
        return 1

    def XFree(self, _value):
        return 1
