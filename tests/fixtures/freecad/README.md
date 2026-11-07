# FreeCAD documents

Each `Document.xml` is unchanged from a `.FCStd` file that a real FreeCAD saved
during a desktop capture: `0.21` from FreeCAD 0.21 (`0.21R33771`) and `1.0` from
FreeCAD 1.0 (`1.0R`), both on Ubuntu. A `.FCStd` file is a zip archive, and
`Document.xml` is the entry that records the document's objects.

`before` holds one `Part::Box` named `Plate`, 160 × 100 × 5 mm. `after` is the
same document once the user cut a 10 mm hole through it and saved: it adds a
`Part::Cylinder` named `Hole` with `Radius` `5.0000000000000000`, and a
`Part::Cut` named `PlateWithHole` whose `Base` links `Plate` and whose `Tool`
links `Hole`.

The two versions write the same objects in different places: FreeCAD 1.0
records more properties, so the hole's `Radius` sits at another position among
its siblings. Tests zip these files into `.FCStd` archives and check them by
name rather than by position.
