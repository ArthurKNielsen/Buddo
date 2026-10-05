"""Procedurally generated Python tasks, so Buddo learns patterns instead of memorizing.

Each family combines a few building blocks (an operation, a condition, a key, a
number...) into many distinct programs. Every program is executed and checked
against an independent reference before it can be used for training.

    python generators.py --check     # build everything and verify it
"""

import contextlib
import io
import math
import random

# An item is a dict:
#   asks:  ways a person might ask for it
#   code:  the solution Buddo should write
#   check: ("func", name, [(args, expected), ...])  call the function and compare
#          ("out", expected_stdout)                    run it and compare what it prints
#          ("expr", python_expression)                 must evaluate truthy after running


def finish(code, fname, example):
    """Append a usage example whose printed result comes from actually running the code."""
    env = {}
    exec(code, env)
    result = env[fname](*example)
    args = ", ".join(repr(a) for a in example)
    return f"{code}\n\n\nprint({fname}({args}))  # {result!r}"


def func_item(asks, fname, params, body, cases, example=None):
    code = f"def {fname}({params}):\n" + "\n".join("    " + line for line in body.split("\n"))
    if "math." in body:
        code = "import math\n\n\n" + code
    code = finish(code, fname, example or cases[0][0])
    return {"asks": asks, "code": code, "check": ("func", fname, cases)}


NUMS = [[3, -1, 8, 10, 5, -6, 12, 7], [1, 2, 3, 4, 5, 6], [15, 22, -3, 0, 9, 40, 51]]
WORDS = [["apple", "kiwi", "banana", "fig", "cherry"], ["sun", "planet", "a", "galaxy", "moon"], ["Python", "is", "really", "fun", "code"]]


# ---------- lists of numbers ----------

def list_filters():
    conds = [
        ("even numbers", "evens", "n % 2 == 0", lambda n: n % 2 == 0),
        ("odd numbers", "odds", "n % 2 != 0", lambda n: n % 2 != 0),
        ("positive numbers", "positives", "n > 0", lambda n: n > 0),
        ("negative numbers", "negatives", "n < 0", lambda n: n < 0),
    ]
    for k in (0, 5, 10, 20, 50, 100):
        conds.append((f"numbers greater than {k}", f"greater_than_{k}", f"n > {k}", lambda n, k=k: n > k))
        conds.append((f"numbers less than {k}", f"less_than_{k}", f"n < {k}", lambda n, k=k: n < k))
    for k in (2, 3, 4, 5, 7, 10):
        conds.append((f"numbers divisible by {k}", f"divisible_by_{k}", f"n % {k} == 0", lambda n, k=k: n % k == 0))
    items = []
    for desc, name, expr, ref in conds:
        asks = [f"keep only the {desc} in a list", f"filter the {desc} from a list", f"get all {desc} from a list",
                f"return the {desc} in a list", f"remove everything except {desc} from a list"]
        cases = [((xs,), [n for n in xs if ref(n)]) for xs in NUMS]
        style = random.choice(["comp", "loop"])
        if style == "comp":
            body = f"return [n for n in numbers if {expr}]"
        else:
            body = f"result = []\nfor n in numbers:\n    if {expr}:\n        result.append(n)\nreturn result"
        items.append(func_item(asks, name, "numbers", body, cases))
        cnt_cases = [((xs,), sum(1 for n in xs if ref(n))) for xs in NUMS]
        items.append(func_item([f"count the {desc} in a list", f"how many {desc} are in a list"],
                               f"count_{name}", "numbers", f"return sum(1 for n in numbers if {expr})", cnt_cases))
        sum_cases = [((xs,), sum(n for n in xs if ref(n))) for xs in NUMS]
        items.append(func_item([f"add up the {desc} in a list", f"sum the {desc} in a list"],
                               f"sum_{name}", "numbers", f"return sum(n for n in numbers if {expr})", sum_cases))
    return items


def list_maps():
    ops = [
        ("double every number in a list", "double_all", "n * 2", lambda n: n * 2),
        ("triple every number in a list", "triple_all", "n * 3", lambda n: n * 3),
        ("square every number in a list", "square_all", "n ** 2", lambda n: n ** 2),
        ("cube every number in a list", "cube_all", "n ** 3", lambda n: n ** 3),
        ("negate every number in a list", "negate_all", "-n", lambda n: -n),
        ("get the absolute value of every number in a list", "absolute_all", "abs(n)", abs),
        ("halve every number in a list", "halve_all", "n / 2", lambda n: n / 2),
        ("turn a list of numbers into strings", "to_strings", "str(n)", str),
    ]
    for k in (1, 2, 5, 10, 100):
        ops.append((f"add {k} to every number in a list", f"add_{k}", f"n + {k}", lambda n, k=k: n + k))
        ops.append((f"subtract {k} from every number in a list", f"subtract_{k}", f"n - {k}", lambda n, k=k: n - k))
        ops.append((f"multiply every number in a list by {k}", f"times_{k}", f"n * {k}", lambda n, k=k: n * k))
    items = []
    for ask, name, expr, ref in ops:
        alt = ask.replace("every number in a list", "each item in a list")
        cases = [((xs,), [ref(n) for n in xs]) for xs in NUMS]
        items.append(func_item([ask, alt], name, "numbers", f"return [{expr} for n in numbers]", cases))
    return items


def list_reductions():
    reds = [
        (["sum a list of numbers", "add up all the numbers in a list", "total of a list"], "total", "return sum(numbers)", sum),
        (["multiply all the numbers in a list", "product of a list of numbers"], "product",
         "result = 1\nfor n in numbers:\n    result *= n\nreturn result", math.prod),
        (["find the largest number in a list", "get the biggest number in a list", "max of a list"], "largest", "return max(numbers)", max),
        (["find the smallest number in a list", "get the lowest number in a list", "min of a list"], "smallest", "return min(numbers)", min),
        (["average of a list of numbers", "find the mean of a list"], "average",
         "return sum(numbers) / len(numbers) if numbers else 0", lambda xs: sum(xs) / len(xs)),
        (["difference between the biggest and smallest number in a list", "range of a list of numbers"], "spread",
         "return max(numbers) - min(numbers)", lambda xs: max(xs) - min(xs)),
        (["find the second largest number in a list", "second biggest number in a list"], "second_largest",
         "unique = sorted(set(numbers))\nreturn unique[-2] if len(unique) > 1 else None", lambda xs: sorted(set(xs))[-2]),
        (["find the index of the largest number in a list", "position of the max in a list"], "index_of_max",
         "return numbers.index(max(numbers))", lambda xs: xs.index(max(xs))),
        (["check if all numbers in a list are positive", "are all numbers positive"], "all_positive",
         "return all(n > 0 for n in numbers)", lambda xs: all(n > 0 for n in xs)),
        (["check if any number in a list is negative", "does a list contain a negative number"], "has_negative",
         "return any(n < 0 for n in numbers)", lambda xs: any(n < 0 for n in xs)),
        (["running total of a list", "cumulative sum of a list"], "running_total",
         "result = []\ntotal = 0\nfor n in numbers:\n    total += n\n    result.append(total)\nreturn result",
         lambda xs: [sum(xs[: i + 1]) for i in range(len(xs))]),
        (["remove duplicates from a list", "unique items in a list keeping order"], "unique",
         "seen = set()\nresult = []\nfor n in numbers:\n    if n not in seen:\n        seen.add(n)\n        result.append(n)\nreturn result",
         lambda xs: list(dict.fromkeys(xs))),
    ]
    items = []
    for asks, name, body, ref in reds:
        cases = [((xs,), ref(xs)) for xs in NUMS]
        items.append(func_item(asks, name, "numbers", body, cases))
    return items


# ---------- sorting ----------

def sorting():
    PEOPLE = [{"name": "Ana", "age": 31, "score": 88}, {"name": "Ben", "age": 19, "score": 95}, {"name": "Cy", "age": 25, "score": 72}]
    PAIRS = [("a", 3), ("b", 1), ("c", 2)]
    specs = [
        (["sort a list of numbers", "sort numbers from smallest to largest"], "sort_numbers", "numbers",
         "return sorted(numbers)", [((xs,), sorted(xs)) for xs in NUMS]),
        (["sort a list of numbers in descending order", "sort numbers from largest to smallest"], "sort_descending", "numbers",
         "return sorted(numbers, reverse=True)", [((xs,), sorted(xs, reverse=True)) for xs in NUMS]),
        (["sort numbers by their absolute value", "sort a list by absolute value"], "sort_by_absolute", "numbers",
         "return sorted(numbers, key=abs)", [((xs,), sorted(xs, key=abs)) for xs in NUMS]),
        (["sort a list of words alphabetically", "sort strings in alphabetical order"], "sort_words", "words",
         "return sorted(words, key=str.lower)", [((ws,), sorted(ws, key=str.lower)) for ws in WORDS]),
        (["sort a list of words by length", "sort strings by how long they are", "order words from shortest to longest"],
         "sort_by_length", "words", "return sorted(words, key=len)", [((ws,), sorted(ws, key=len)) for ws in WORDS]),
        (["sort words by length from longest to shortest", "sort strings by length descending"], "sort_by_length_desc", "words",
         "return sorted(words, key=len, reverse=True)", [((ws,), sorted(ws, key=len, reverse=True)) for ws in WORDS]),
        (["sort words by their last letter", "sort strings by the last character"], "sort_by_last_letter", "words",
         "return sorted(words, key=lambda w: w[-1])", [((ws,), sorted(ws, key=lambda w: w[-1])) for ws in WORDS]),
        (["sort a list of tuples by the second item", "sort pairs by their second value"], "sort_by_second", "pairs",
         "return sorted(pairs, key=lambda p: p[1])", [((PAIRS,), sorted(PAIRS, key=lambda p: p[1]))]),
    ]
    for key in ("age", "score", "name"):
        specs.append(([f"sort a list of dictionaries by {key}", f"sort people by their {key}"], f"sort_by_{key}", "people",
                      f'return sorted(people, key=lambda p: p["{key}"])', [((PEOPLE,), sorted(PEOPLE, key=lambda p: p[key]))]))
        specs.append(([f"sort a list of dictionaries by {key} from highest to lowest", f"sort people by {key} descending"],
                      f"sort_by_{key}_desc", "people", f'return sorted(people, key=lambda p: p["{key}"], reverse=True)',
                      [((PEOPLE,), sorted(PEOPLE, key=lambda p: p[key], reverse=True))]))
    return [func_item(a, n, p, b, c) for a, n, p, b, c in specs]


# ---------- strings ----------

TEXTS = ["Hello World", "Python is fun", "racecar", "The quick brown fox"]


def strings():
    specs = [
        (["reverse a string", "flip a string backwards"], "reverse_string", "text", "return text[::-1]", lambda t: t[::-1]),
        (["make a string uppercase", "convert text to all caps"], "to_upper", "text", "return text.upper()", str.upper),
        (["make a string lowercase", "convert text to lowercase"], "to_lower", "text", "return text.lower()", str.lower),
        (["capitalize every word in a string", "title case a sentence"], "title_case", "text",
         'return " ".join(word.capitalize() for word in text.split())', lambda t: " ".join(w.capitalize() for w in t.split())),
        (["swap the case of every letter", "swap uppercase and lowercase in a string"], "swap_case", "text", "return text.swapcase()", str.swapcase),
        (["count the vowels in a string", "how many vowels are in a word"], "count_vowels", "text",
         'return sum(1 for c in text.lower() if c in "aeiou")', lambda t: sum(c in "aeiou" for c in t.lower())),
        (["count the consonants in a string", "how many consonants are in a word"], "count_consonants", "text",
         'return sum(1 for c in text.lower() if c.isalpha() and c not in "aeiou")',
         lambda t: sum(c.isalpha() and c not in "aeiou" for c in t.lower())),
        (["remove the vowels from a string", "delete all vowels from text"], "remove_vowels", "text",
         'return "".join(c for c in text if c.lower() not in "aeiou")', lambda t: "".join(c for c in t if c.lower() not in "aeiou")),
        (["count the words in a sentence", "how many words are in a string"], "count_words", "text", "return len(text.split())", lambda t: len(t.split())),
        (["reverse the order of words in a sentence", "flip the words in a string"], "reverse_words", "text",
         'return " ".join(reversed(text.split()))', lambda t: " ".join(reversed(t.split()))),
        (["find the longest word in a sentence", "get the longest word in a string"], "longest_word", "text",
         "return max(text.split(), key=len)", lambda t: max(t.split(), key=len)),
        (["find the shortest word in a sentence", "get the shortest word in a string"], "shortest_word", "text",
         "return min(text.split(), key=len)", lambda t: min(t.split(), key=len)),
        (["remove spaces from a string", "delete all whitespace from text"], "remove_spaces", "text",
         'return "".join(text.split())', lambda t: "".join(t.split())),
        (["check if a string is a palindrome", "is a word the same backwards"], "is_palindrome", "text",
         'cleaned = "".join(c.lower() for c in text if c.isalnum())\nreturn cleaned == cleaned[::-1]',
         lambda t: "".join(c.lower() for c in t if c.isalnum()) == "".join(c.lower() for c in t if c.isalnum())[::-1]),
        (["make an acronym from a phrase", "get the first letter of each word in uppercase"], "acronym", "text",
         'return "".join(word[0].upper() for word in text.split())', lambda t: "".join(w[0].upper() for w in t.split())),
        (["count the uppercase letters in a string", "how many capital letters are in text"], "count_uppercase", "text",
         "return sum(1 for c in text if c.isupper())", lambda t: sum(c.isupper() for c in t)),
        (["get the length of each word in a sentence", "list the word lengths in a string"], "word_lengths", "text",
         "return [len(word) for word in text.split()]", lambda t: [len(w) for w in t.split()]),
        (["split a sentence into a list of words", "turn a string into a list of words"], "split_words", "text",
         "return text.split()", str.split),
        (["remove duplicate characters from a string", "keep only the first of each letter in a string"], "dedupe_chars", "text",
         'seen = set()\nresult = ""\nfor c in text:\n    if c not in seen:\n        seen.add(c)\n        result += c\nreturn result',
         lambda t: "".join(dict.fromkeys(t))),
        (["count how many times each character appears", "character frequency of a string"], "char_counts", "text",
         "counts = {}\nfor c in text:\n    counts[c] = counts.get(c, 0) + 1\nreturn counts",
         lambda t: {c: t.count(c) for c in dict.fromkeys(t)}),
        (["count how many times each word appears", "word frequency in a sentence"], "word_counts", "text",
         "counts = {}\nfor word in text.lower().split():\n    counts[word] = counts.get(word, 0) + 1\nreturn counts",
         lambda t: {w: t.lower().split().count(w) for w in dict.fromkeys(t.lower().split())}),
    ]
    items = [func_item(a, n, p, b, [((t,), ref(t)) for t in TEXTS]) for a, n, p, b, ref in specs]

    for ch in "aeost":
        items.append(func_item([f"count how many times the letter {ch} appears in a string", f"count the letter {ch} in text"],
                               f"count_{ch}", "text", f'return text.lower().count("{ch}")',
                               [((t,), t.lower().count(ch)) for t in TEXTS]))
        items.append(func_item([f"remove every letter {ch} from a string", f"delete the letter {ch} from text"],
                               f"remove_{ch}", "text", f'return text.replace("{ch}", "")',
                               [((t,), t.replace(ch, "")) for t in TEXTS]))
    for n in (1, 2, 3, 5):
        items.append(func_item([f"get the first {n} characters of a string", f"first {n} letters of a word"],
                               f"first_{n}", "text", f"return text[:{n}]", [((t,), t[:n]) for t in TEXTS]))
        items.append(func_item([f"get the last {n} characters of a string", f"last {n} letters of a word"],
                               f"last_{n}", "text", f"return text[-{n}:]", [((t,), t[-n:]) for t in TEXTS]))
    for a, b in (("cat", "dog"), ("bad", "good"), ("red", "blue"), ("hello", "hi")):
        tests = [f"the {a} sat", f"{a} {a}", "nothing here"]
        items.append(func_item([f"replace the word {a} with {b} in a string", f"swap {a} for {b} in text"],
                               f"replace_{a}", "text", f'return text.replace("{a}", "{b}")',
                               [((t,), t.replace(a, b)) for t in tests]))
    return items


def word_lists():
    items = []
    for k in (3, 4, 5):
        items.append(func_item([f"keep only words longer than {k} letters", f"filter words with more than {k} characters"],
                               f"longer_than_{k}", "words", f"return [w for w in words if len(w) > {k}]",
                               [((ws,), [w for w in ws if len(w) > k]) for ws in WORDS]))
        items.append(func_item([f"keep only words shorter than {k} letters", f"filter words with fewer than {k} characters"],
                               f"shorter_than_{k}", "words", f"return [w for w in words if len(w) < {k}]",
                               [((ws,), [w for w in ws if len(w) < k]) for ws in WORDS]))
    for ch in "abcs":
        items.append(func_item([f"find the words that start with {ch}", f"filter words beginning with the letter {ch}"],
                               f"starts_with_{ch}", "words", f'return [w for w in words if w.lower().startswith("{ch}")]',
                               [((ws,), [w for w in ws if w.lower().startswith(ch)]) for ws in WORDS]))
        items.append(func_item([f"find the words that contain the letter {ch}", f"words with {ch} in them"],
                               f"contains_{ch}", "words", f'return [w for w in words if "{ch}" in w.lower()]',
                               [((ws,), [w for w in ws if ch in w.lower()]) for ws in WORDS]))
    specs = [
        (["make every word in a list uppercase", "uppercase a list of strings"], "upper_all", "return [w.upper() for w in words]", lambda ws: [w.upper() for w in ws]),
        (["get the length of each word in a list", "lengths of a list of strings"], "lengths", "return [len(w) for w in words]", lambda ws: [len(w) for w in ws]),
        (["get the first letter of each word in a list", "first character of every string in a list"], "first_letters", "return [w[0] for w in words]", lambda ws: [w[0] for w in ws]),
        (["join a list of words into a sentence", "combine strings with spaces"], "join_words", 'return " ".join(words)', " ".join),
        (["find the longest word in a list", "longest string in a list"], "longest", "return max(words, key=len)", lambda ws: max(ws, key=len)),
        (["count the total letters in a list of words", "total characters in a list of strings"], "total_letters", "return sum(len(w) for w in words)", lambda ws: sum(map(len, ws))),
        (["make a dictionary of words and their lengths", "map each word to its length"], "length_map", "return {w: len(w) for w in words}", lambda ws: {w: len(w) for w in ws}),
    ]
    for asks, name, body, ref in specs:
        items.append(func_item(asks, name, "words", body, [((ws,), ref(ws)) for ws in WORDS]))
    return items


# ---------- math and formulas ----------

def formulas():
    specs = [
        (["area of a rectangle", "calculate the area of a rectangle"], "rectangle_area", "width, height", "return width * height", lambda w, h: w * h, [(3, 4), (5, 2.5)]),
        (["perimeter of a rectangle", "calculate the perimeter of a rectangle"], "rectangle_perimeter", "width, height", "return 2 * (width + height)", lambda w, h: 2 * (w + h), [(3, 4), (10, 1)]),
        (["area of a square", "calculate the area of a square"], "square_area", "side", "return side ** 2", lambda s: s ** 2, [(4,), (2.5,)]),
        (["area of a triangle", "calculate the area of a triangle from base and height"], "triangle_area", "base, height", "return base * height / 2", lambda b, h: b * h / 2, [(6, 4), (3, 3)]),
        (["area of a circle", "calculate the area of a circle from its radius"], "circle_area", "radius", "return math.pi * radius ** 2", lambda r: math.pi * r ** 2, [(1,), (3,)]),
        (["circumference of a circle", "perimeter of a circle"], "circumference", "radius", "return 2 * math.pi * radius", lambda r: 2 * math.pi * r, [(1,), (5,)]),
        (["volume of a cube", "calculate the volume of a cube"], "cube_volume", "side", "return side ** 3", lambda s: s ** 3, [(3,), (1.5,)]),
        (["volume of a sphere", "calculate the volume of a ball"], "sphere_volume", "radius", "return 4 / 3 * math.pi * radius ** 3", lambda r: 4 / 3 * math.pi * r ** 3, [(1,), (2,)]),
        (["volume of a cylinder", "calculate the volume of a cylinder"], "cylinder_volume", "radius, height", "return math.pi * radius ** 2 * height", lambda r, h: math.pi * r * r * h, [(1, 2), (3, 1)]),
        (["volume of a box", "volume of a rectangular prism"], "box_volume", "length, width, height", "return length * width * height", lambda l, w, h: l * w * h, [(2, 3, 4)]),
        (["hypotenuse of a right triangle", "pythagorean theorem"], "hypotenuse", "a, b", "return math.sqrt(a ** 2 + b ** 2)", lambda a, b: math.hypot(a, b), [(3, 4), (5, 12)]),
        (["convert celsius to fahrenheit", "celsius to fahrenheit"], "c_to_f", "celsius", "return celsius * 9 / 5 + 32", lambda c: c * 9 / 5 + 32, [(100,), (0,), (-40,)]),
        (["convert fahrenheit to celsius", "fahrenheit to celsius"], "f_to_c", "fahrenheit", "return (fahrenheit - 32) * 5 / 9", lambda f: (f - 32) * 5 / 9, [(212,), (32,)]),
        (["convert kilometers to miles", "km to miles"], "km_to_miles", "km", "return km * 0.621371", lambda k: k * 0.621371, [(10,), (42.195,)]),
        (["convert miles to kilometers", "miles to km"], "miles_to_km", "miles", "return miles * 1.609344", lambda m: m * 1.609344, [(1,), (26.2,)]),
        (["convert kilograms to pounds", "kg to lbs"], "kg_to_lb", "kg", "return kg * 2.20462", lambda k: k * 2.20462, [(1,), (70,)]),
        (["convert pounds to kilograms", "lbs to kg"], "lb_to_kg", "pounds", "return pounds / 2.20462", lambda p: p / 2.20462, [(150,), (2.20462,)]),
        (["convert inches to centimeters", "inches to cm"], "inches_to_cm", "inches", "return inches * 2.54", lambda i: i * 2.54, [(1,), (12,)]),
        (["convert meters to feet", "meters to feet"], "meters_to_feet", "meters", "return meters * 3.28084", lambda m: m * 3.28084, [(1,), (100,)]),
        (["convert hours to minutes", "how many minutes in some hours"], "hours_to_minutes", "hours", "return hours * 60", lambda h: h * 60, [(2,), (1.5,)]),
        (["convert minutes to seconds", "minutes to seconds"], "minutes_to_seconds", "minutes", "return minutes * 60", lambda m: m * 60, [(3,), (0.5,)]),
        (["convert days to hours", "how many hours in some days"], "days_to_hours", "days", "return days * 24", lambda d: d * 24, [(2,), (7,)]),
        (["convert seconds to minutes and seconds", "format seconds as minutes and seconds"], "split_seconds", "seconds",
         "return seconds // 60, seconds % 60", lambda s: (s // 60, s % 60), [(125,), (59,)]),
        (["calculate a percentage", "what percent is one number of another"], "percent", "part, whole", "return part / whole * 100", lambda p, w: p / w * 100, [(25, 200), (3, 4)]),
        (["apply a discount to a price", "calculate the sale price after a discount"], "discounted_price", "price, percent_off",
         "return price * (1 - percent_off / 100)", lambda p, d: p * (1 - d / 100), [(80, 25), (19.99, 10)]),
        (["calculate a tip", "tip calculator"], "tip", "bill, percent", "return bill * percent / 100", lambda b, p: b * p / 100, [(50, 20), (32.5, 15)]),
        (["calculate simple interest", "simple interest calculator"], "simple_interest", "principal, rate, years",
         "return principal * rate * years / 100", lambda p, r, y: p * r * y / 100, [(1000, 5, 3)]),
        (["calculate compound interest", "compound interest calculator"], "compound_interest", "principal, rate, years",
         "return principal * (1 + rate / 100) ** years", lambda p, r, y: p * (1 + r / 100) ** y, [(1000, 5, 10)]),
        (["calculate bmi", "body mass index"], "bmi", "weight_kg, height_m", "return weight_kg / height_m ** 2", lambda w, h: w / h ** 2, [(70, 1.75)]),
        (["average of three numbers", "mean of three numbers"], "average_of_three", "a, b, c", "return (a + b + c) / 3", lambda a, b, c: (a + b + c) / 3, [(1, 2, 3), (10, 0, 5)]),
        (["find the bigger of two numbers", "max of two numbers"], "bigger", "a, b", "return a if a > b else b", max, [(3, 9), (-2, -7)]),
        (["find the biggest of three numbers", "max of three numbers"], "biggest_of_three", "a, b, c", "return max(a, b, c)", max, [(3, 9, 4), (7, 1, 2)]),
        (["absolute difference between two numbers", "distance between two numbers"], "difference", "a, b", "return abs(a - b)", lambda a, b: abs(a - b), [(3, 10), (10, 3)]),
        (["check if a number is divisible by another", "is one number a multiple of another"], "is_divisible", "n, d", "return n % d == 0", lambda n, d: n % d == 0, [(10, 5), (10, 3)]),
        (["raise a number to a power", "calculate x to the power of n"], "power", "base, exponent", "return base ** exponent", pow, [(2, 10), (3, 3)]),
        (["square root of a number", "calculate a square root"], "square_root", "n", "return math.sqrt(n)", math.sqrt, [(16,), (2,)]),
        (["sum of the numbers from 1 to n", "add up all numbers from 1 to n"], "sum_to_n", "n", "return n * (n + 1) // 2", lambda n: n * (n + 1) // 2, [(10,), (100,)]),
        (["factorial of a number", "calculate n factorial"], "factorial", "n",
         "result = 1\nfor i in range(2, n + 1):\n    result *= i\nreturn result", math.factorial, [(5,), (0,), (10,)]),
        (["nth fibonacci number", "fibonacci function"], "fibonacci", "n",
         "a, b = 0, 1\nfor _ in range(n):\n    a, b = b, a + b\nreturn a", None, [(10,), (1,), (20,)]),
        (["check if a number is prime", "is a number prime"], "is_prime", "n",
         "if n < 2:\n    return False\ni = 2\nwhile i * i <= n:\n    if n % i == 0:\n        return False\n    i += 1\nreturn True",
         lambda n: n > 1 and all(n % i for i in range(2, int(n ** 0.5) + 1)), [(13,), (1,), (21,), (97,)]),
        (["greatest common divisor of two numbers", "gcd"], "gcd", "a, b", "while b:\n    a, b = b, a % b\nreturn a", math.gcd, [(48, 18), (7, 3)]),
        (["check if a year is a leap year", "is it a leap year"], "is_leap_year", "year",
         "return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)", lambda y: y % 4 == 0 and (y % 100 != 0 or y % 400 == 0),
         [(2024,), (1900,), (2000,), (2023,)]),
        (["sum the digits of a number", "add up the digits in a number"], "digit_sum", "n", "return sum(int(d) for d in str(abs(n)))",
         lambda n: sum(int(d) for d in str(abs(n))), [(1234,), (909,)]),
        (["count the digits in a number", "how many digits does a number have"], "count_digits", "n", "return len(str(abs(n)))",
         lambda n: len(str(abs(n))), [(12345,), (7,)]),
        (["convert a number to binary", "decimal to binary"], "to_binary", "n", 'return bin(n)[2:]', lambda n: format(n, "b"), [(10,), (255,)]),
        (["convert binary to a number", "binary string to decimal"], "from_binary", "bits", "return int(bits, 2)", lambda b: int(b, 2), [("1010",), ("11111111",)]),
        (["check if a number is even", "is a number even"], "is_even", "n", "return n % 2 == 0", lambda n: n % 2 == 0, [(4,), (7,)]),
        (["check if a number is a perfect square", "is a number a square number"], "is_perfect_square", "n",
         "root = int(n ** 0.5)\nreturn root * root == n", lambda n: math.isqrt(n) ** 2 == n, [(16,), (15,), (1,)]),
    ]
    items = []
    for asks, name, params, body, ref, inputs in specs:
        cases = [(args, (ref or _fib)(*args)) for args in inputs]
        items.append(func_item(asks, name, params, body, cases))
    return items


def _fib(n):
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a


# ---------- dictionaries ----------

def dicts():
    SCORES = [{"ana": 88, "ben": 95, "cy": 72}, {"x": 1, "y": 3, "z": 2}]
    specs = [
        (["find the key with the highest value in a dictionary", "who has the top score in a dict"], "top_key", "scores",
         "return max(scores, key=scores.get)", lambda d: max(d, key=d.get)),
        (["find the key with the lowest value in a dictionary", "who has the lowest score in a dict"], "bottom_key", "scores",
         "return min(scores, key=scores.get)", lambda d: min(d, key=d.get)),
        (["sum all the values in a dictionary", "total of a dict's values"], "sum_values", "scores", "return sum(scores.values())", lambda d: sum(d.values())),
        (["average of the values in a dictionary", "mean of a dict's values"], "average_value", "scores",
         "return sum(scores.values()) / len(scores)", lambda d: sum(d.values()) / len(d)),
        (["swap the keys and values in a dictionary", "invert a dictionary"], "invert", "scores", "return {v: k for k, v in scores.items()}", lambda d: {v: k for k, v in d.items()}),
        (["sort a dictionary by its values", "order a dict by value"], "sort_by_value", "scores",
         "return dict(sorted(scores.items(), key=lambda item: item[1]))", lambda d: dict(sorted(d.items(), key=lambda i: i[1]))),
        (["get a sorted list of a dictionary's keys", "sorted keys of a dict"], "sorted_keys", "scores", "return sorted(scores)", sorted),
    ]
    items = [func_item(a, n, p, b, [((d,), ref(d)) for d in SCORES]) for a, n, p, b, ref in specs]
    for k in (2, 80, 90):
        items.append(func_item([f"keep the dictionary entries with a value above {k}", f"filter a dict to values greater than {k}"],
                               f"above_{k}", "scores", f"return {{k: v for k, v in scores.items() if v > {k}}}",
                               [((d,), {a: v for a, v in d.items() if v > k}) for d in SCORES]))
    items.append(func_item(["merge two dictionaries", "combine two dicts"], "merge", "a, b", "return {**a, **b}",
                           [(({"a": 1}, {"b": 2}), {"a": 1, "b": 2}), (({"a": 1}, {"a": 5}), {"a": 5})]))
    items.append(func_item(["make a dictionary from two lists", "zip keys and values into a dict"], "make_dict", "keys, values",
                           "return dict(zip(keys, values))", [((["a", "b"], [1, 2]), {"a": 1, "b": 2})]))
    return items


# ---------- programs that print ----------

def run_stdout(code):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        exec(code, {})
    return buf.getvalue()


def printing():
    items = []
    for n in (5, 10, 20, 100):
        progs = [
            ([f"print the numbers from 1 to {n}", f"count from 1 to {n}", f"loop from 1 to {n}"], f"for i in range(1, {n + 1}):\n    print(i)"),
            ([f"print the even numbers up to {n}", f"show even numbers from 1 to {n}"], f"for i in range(2, {n + 1}, 2):\n    print(i)"),
            ([f"print the odd numbers up to {n}", f"show odd numbers from 1 to {n}"], f"for i in range(1, {n + 1}, 2):\n    print(i)"),
            ([f"count down from {n}", f"print a countdown from {n} to 1"], f"for i in range({n}, 0, -1):\n    print(i)\nprint(\"Liftoff!\")"),
            ([f"print the squares of the numbers from 1 to {n}", f"show squares up to {n}"], f"for i in range(1, {n + 1}):\n    print(i, i * i)"),
            ([f"add up the numbers from 1 to {n} with a loop", f"sum 1 to {n} using a loop"], f"total = 0\nfor i in range(1, {n + 1}):\n    total += i\nprint(total)"),
        ]
        for asks, code in progs:
            items.append({"asks": asks, "code": code, "check": ("out", run_stdout(code))})
    for k in (2, 3, 5, 7, 9, 12):
        code = f"for i in range(1, 11):\n    print(f\"{k} x {{i}} = {{{k} * i}}\")"
        items.append({"asks": [f"print the {k} times table", f"multiplication table for {k}"], "code": code, "check": ("out", run_stdout(code))})
    for n in (3, 4, 5, 6):
        shapes = [
            ([f"print a triangle of stars with {n} rows", f"star triangle {n} rows tall"], f"for i in range(1, {n + 1}):\n    print(\"*\" * i)"),
            ([f"print an upside down triangle of stars with {n} rows", f"reverse star triangle {n} rows"], f"for i in range({n}, 0, -1):\n    print(\"*\" * i)"),
            ([f"print a {n} by {n} square of stars", f"star square of size {n}"], f"for _ in range({n}):\n    print(\"*\" * {n})"),
            ([f"print a pyramid of stars {n} rows tall", f"centered star pyramid with {n} rows"],
             f"for i in range(1, {n + 1}):\n    print(\" \" * ({n} - i) + \"*\" * (2 * i - 1))"),
        ]
        for asks, code in shapes:
            items.append({"asks": asks, "code": code, "check": ("out", run_stdout(code))})
    code = 'for i in range(1, 101):\n    if i % 15 == 0:\n        print("FizzBuzz")\n    elif i % 3 == 0:\n        print("Fizz")\n    elif i % 5 == 0:\n        print("Buzz")\n    else:\n        print(i)'
    items.append({"asks": ["fizzbuzz", "print fizzbuzz from 1 to 100"], "code": code, "check": ("out", run_stdout(code))})
    return items


# ---------- classes ----------

def classes():
    specs = [
        ("Dog", ["name", "age"], ("bark", 'return f"{self.name} says woof!"'), 'Dog("Rex", 3)', "obj.bark() == 'Rex says woof!'"),
        ("Cat", ["name", "color"], ("meow", 'return f"{self.name} says meow"'), 'Cat("Luna", "black")', "obj.meow() == 'Luna says meow'"),
        ("Car", ["make", "model", "year"], ("describe", 'return f"{self.year} {self.make} {self.model}"'), 'Car("Toyota", "Corolla", 2020)', "obj.describe() == '2020 Toyota Corolla'"),
        ("Book", ["title", "author"], ("describe", 'return f"{self.title} by {self.author}"'), 'Book("Dune", "Frank Herbert")', "obj.describe() == 'Dune by Frank Herbert'"),
        ("Student", ["name", "grades"], ("average", "return sum(self.grades) / len(self.grades)"), 'Student("Mia", [90, 80, 70])', "obj.average() == 80"),
        ("Rectangle", ["width", "height"], ("area", "return self.width * self.height"), "Rectangle(3, 4)", "obj.area() == 12"),
        ("Circle", ["radius"], ("area", "return 3.14159 * self.radius ** 2"), "Circle(2)", "round(obj.area(), 2) == 12.57"),
        ("Player", ["name", "health"], ("take_damage", "self.health = max(0, self.health - amount)\nreturn self.health"), 'Player("Hero", 100)', "obj.take_damage(30) == 70"),
        ("Product", ["name", "price"], ("with_tax", "return round(self.price * 1.08, 2)"), 'Product("Pen", 2.5)', "obj.with_tax() == 2.7"),
        ("Person", ["name", "age"], ("greet", 'return f"Hi, I\'m {self.name} and I\'m {self.age}"'), 'Person("Sam", 16)', "obj.greet() == \"Hi, I'm Sam and I'm 16\""),
    ]
    items = []
    for cls, attrs, (method, body), make, test in specs:
        params = ", ".join(attrs)
        init = "\n".join(f"        self.{a} = {a}" for a in attrs)
        mparams = "self, amount" if "amount" in body else "self"
        mbody = "\n".join("        " + l for l in body.split("\n"))
        code = f"class {cls}:\n    def __init__(self, {params}):\n{init}\n\n    def {method}({mparams}):\n{mbody}\n\n\nobj = {make}"
        if mparams == "self":
            code += f"\nprint(obj.{method}())"
        noun = cls.lower()
        asks = [f"make a {noun} class", f"create a class for a {noun} with {' and '.join(attrs)}",
                f"write a {cls} class with a {method} method", f"python class for a {noun}"]
        items.append({"asks": asks, "code": code, "check": ("expr", test)})
    stack = 'class Stack:\n    def __init__(self):\n        self.items = []\n\n    def push(self, item):\n        self.items.append(item)\n\n    def pop(self):\n        return self.items.pop()\n\n    def is_empty(self):\n        return not self.items\n\n\nobj = Stack()\nobj.push(1)\nobj.push(2)\nprint(obj.pop())  # 2'
    items.append({"asks": ["make a stack class", "implement a stack", "stack with push and pop"], "code": stack, "check": ("expr", "obj.items == [1]")})
    queue = 'from collections import deque\n\n\nclass Queue:\n    def __init__(self):\n        self.items = deque()\n\n    def enqueue(self, item):\n        self.items.append(item)\n\n    def dequeue(self):\n        return self.items.popleft()\n\n\nobj = Queue()\nobj.enqueue("a")\nobj.enqueue("b")\nprint(obj.dequeue())  # a'
    items.append({"asks": ["make a queue class", "implement a queue", "queue with enqueue and dequeue"], "code": queue, "check": ("expr", "list(obj.items) == ['b']")})
    counter = 'class Counter:\n    def __init__(self):\n        self.count = 0\n\n    def increment(self):\n        self.count += 1\n        return self.count\n\n    def reset(self):\n        self.count = 0\n\n\nobj = Counter()\nobj.increment()\nprint(obj.increment())  # 2'
    items.append({"asks": ["make a counter class", "class that counts up", "counter with increment and reset"], "code": counter, "check": ("expr", "obj.count == 2")})
    return items


FAMILIES = [list_filters, list_maps, list_reductions, sorting, strings, word_lists, formulas, dicts, printing, classes]


def check_item(item):
    kind = item["check"][0]
    buf = io.StringIO()
    env = {}
    with contextlib.redirect_stdout(buf):
        exec(item["code"], env)
    if kind == "func":
        _, name, cases = item["check"]
        for args, expected in cases:
            got = env[name](*args)
            ok = math.isclose(got, expected, rel_tol=1e-9) if isinstance(expected, float) else got == expected
            if not ok:
                raise AssertionError(f"{name}{args} = {got!r}, expected {expected!r}")
    elif kind == "out":
        if buf.getvalue() != item["check"][1]:
            raise AssertionError("printed output differs")
    elif kind == "expr":
        if not eval(item["check"][1], env):
            raise AssertionError(item["check"][1])


def all_items(seed=0):
    random.seed(seed)
    items = [it for fam in FAMILIES for it in fam()]
    for it in items:
        check_item(it)
    return items


if __name__ == "__main__":
    items = all_items()
    print(f"{len(items)} generated programs, all verified")
    for fam in FAMILIES:
        print(f"  {fam.__name__}: {len(fam())}")
