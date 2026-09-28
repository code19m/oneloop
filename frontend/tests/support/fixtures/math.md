# Math and GitHub-specific extras

These features go beyond ordinary Markdown typography. Compare the exact same
file on GitHub and in oneloop.

## Inline math

Completion ratio: $r = \frac{d}{n}$.

For six completed tasks out of seventeen, $r \approx 0.353$.

GitHub's alternative inline notation: $`a^2 + b^2 = c^2`$.

## Display math

$$
\text{completion percentage} = \frac{\text{completed tasks}}{\text{total tasks}} \times 100
$$

```math
\bar{x} = \frac{1}{n}\sum_{i=1}^{n} x_i
```

## Alerts

> [!NOTE]
> Notes should have a distinct label and visual treatment on GitHub.

> [!TIP]
> Compare both themes and a narrow viewport.

> [!IMPORTANT]
> A diagram shown as source code has not been rendered successfully.

> [!WARNING]
> GitHub-specific syntax is not guaranteed by a basic GFM parser.

> [!CAUTION]
> A successful file upload does not prove preview compatibility.

## Footnotes

Task descriptions should preserve their content.[^content]

Thread replies should keep the original target.[^reply]

[^content]: Rendering changes presentation, not the downloaded original.
[^reply]: Replies stay one level deep while retaining their exact reply target.

## A wide code line

```text
project=oneloop task=BIR-101 state=in_progress owner=taylorwu checklist="keyboard, mobile, light theme, dark theme, readable tables, complete diagrams, preserved source, no horizontal overflow outside the preview"
```

The code block may scroll horizontally; the surrounding page should not.
