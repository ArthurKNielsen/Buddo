"""Hand-written everyday Python tasks and chat replies for fine-tuning.

Every solution is executed and checked by `python tasks.py --check`, so Buddo
only learns code that actually works.
"""

import random
import sys

# (ways people ask, solution, check that must be true after running the solution)
TASKS = [
    (["reverse a string", "reverse text", "flip a string backwards", "reverse the characters in a string"],
     'def reverse_string(s):\n    return s[::-1]\n\n\nprint(reverse_string("hello"))  # olleh',
     'reverse_string("abc") == "cba"'),
    (["check if a string is a palindrome", "test whether a word is a palindrome", "palindrome checker"],
     'def is_palindrome(s):\n    s = "".join(c.lower() for c in s if c.isalnum())\n    return s == s[::-1]\n\n\nprint(is_palindrome("Racecar"))  # True',
     'is_palindrome("A man, a plan, a canal: Panama") and not is_palindrome("hello")'),
    (["sum a list of numbers", "add up all numbers in a list", "get the total of a list"],
     'def total(numbers):\n    result = 0\n    for n in numbers:\n        result += n\n    return result\n\n\nprint(total([1, 2, 3, 4]))  # 10',
     'total([1, 2, 3]) == 6 and total([]) == 0'),
    (["find the largest number in a list", "get the max of a list without using max", "find the biggest number in a list"],
     'def largest(numbers):\n    biggest = numbers[0]\n    for n in numbers[1:]:\n        if n > biggest:\n            biggest = n\n    return biggest\n\n\nprint(largest([3, 9, 2, 7]))  # 9',
     'largest([3, 9, 2]) == 9 and largest([-5, -2]) == -2'),
    (["find the smallest number in a list", "get the minimum of a list", "find the lowest number in a list"],
     'def smallest(numbers):\n    lowest = numbers[0]\n    for n in numbers[1:]:\n        if n < lowest:\n            lowest = n\n    return lowest\n\n\nprint(smallest([3, 9, 2, 7]))  # 2',
     'smallest([3, 9, 2]) == 2'),
    (["calculate the average of a list", "find the mean of some numbers", "average of a list of numbers"],
     'def average(numbers):\n    if not numbers:\n        return 0\n    return sum(numbers) / len(numbers)\n\n\nprint(average([2, 4, 6]))  # 4.0',
     'average([2, 4, 6]) == 4 and average([]) == 0'),
    (["calculate the factorial of a number", "factorial function", "compute n factorial"],
     'def factorial(n):\n    result = 1\n    for i in range(2, n + 1):\n        result *= i\n    return result\n\n\nprint(factorial(5))  # 120',
     'factorial(5) == 120 and factorial(0) == 1'),
    (["calculate factorial using recursion", "recursive factorial"],
     'def factorial(n):\n    if n <= 1:\n        return 1\n    return n * factorial(n - 1)\n\n\nprint(factorial(6))  # 720',
     'factorial(6) == 720'),
    (["get the nth fibonacci number", "fibonacci function", "compute fibonacci numbers"],
     'def fibonacci(n):\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a\n\n\nprint(fibonacci(10))  # 55',
     'fibonacci(10) == 55 and fibonacci(0) == 0'),
    (["print the first n fibonacci numbers", "make a list of fibonacci numbers", "generate the fibonacci sequence"],
     'def fibonacci_list(n):\n    seq = []\n    a, b = 0, 1\n    for _ in range(n):\n        seq.append(a)\n        a, b = b, a + b\n    return seq\n\n\nprint(fibonacci_list(8))  # [0, 1, 1, 2, 3, 5, 8, 13]',
     'fibonacci_list(5) == [0, 1, 1, 2, 3]'),
    (["check if a number is prime", "test whether a number is prime", "prime number checker"],
     'def is_prime(n):\n    if n < 2:\n        return False\n    i = 2\n    while i * i <= n:\n        if n % i == 0:\n            return False\n        i += 1\n    return True\n\n\nprint(is_prime(13))  # True',
     'is_prime(13) and not is_prime(1) and not is_prime(15)'),
    (["list all prime numbers up to n", "find primes below a number", "generate prime numbers"],
     'def primes_up_to(n):\n    primes = []\n    for num in range(2, n + 1):\n        if all(num % p != 0 for p in primes if p * p <= num):\n            primes.append(num)\n    return primes\n\n\nprint(primes_up_to(20))  # [2, 3, 5, 7, 11, 13, 17, 19]',
     'primes_up_to(20) == [2, 3, 5, 7, 11, 13, 17, 19]'),
    (["check if a number is even", "test if a number is even or odd", "even or odd checker"],
     'def is_even(n):\n    return n % 2 == 0\n\n\nprint(is_even(4))  # True\nprint(is_even(7))  # False',
     'is_even(4) and not is_even(7)'),
    (["count the vowels in a string", "how many vowels are in a word", "count vowels"],
     'def count_vowels(text):\n    return sum(1 for c in text.lower() if c in "aeiou")\n\n\nprint(count_vowels("Hello World"))  # 3',
     'count_vowels("Hello World") == 3'),
    (["count the words in a sentence", "count how many words are in a string", "word counter"],
     'def count_words(text):\n    return len(text.split())\n\n\nprint(count_words("the quick brown fox"))  # 4',
     'count_words("the quick  brown fox") == 4'),
    (["count how many times each word appears", "word frequency counter", "count word occurrences in text"],
     'def word_counts(text):\n    counts = {}\n    for word in text.lower().split():\n        counts[word] = counts.get(word, 0) + 1\n    return counts\n\n\nprint(word_counts("the cat and the hat"))',
     'word_counts("a b a") == {"a": 2, "b": 1}'),
    (["count how many times each character appears", "character frequency in a string", "count letters in a string"],
     'def char_counts(text):\n    counts = {}\n    for c in text:\n        counts[c] = counts.get(c, 0) + 1\n    return counts\n\n\nprint(char_counts("banana"))  # {\'b\': 1, \'a\': 3, \'n\': 2}',
     'char_counts("aab") == {"a": 2, "b": 1}'),
    (["remove duplicates from a list", "get the unique items in a list", "dedupe a list keeping order"],
     'def remove_duplicates(items):\n    seen = set()\n    result = []\n    for item in items:\n        if item not in seen:\n            seen.add(item)\n            result.append(item)\n    return result\n\n\nprint(remove_duplicates([1, 2, 2, 3, 1]))  # [1, 2, 3]',
     'remove_duplicates([1, 2, 2, 3, 1]) == [1, 2, 3]'),
    (["sort a list of numbers", "sort numbers from smallest to largest", "order a list"],
     'def sort_numbers(numbers):\n    return sorted(numbers)\n\n\nprint(sort_numbers([5, 2, 9, 1]))  # [1, 2, 5, 9]',
     'sort_numbers([3, 1, 2]) == [1, 2, 3]'),
    (["sort a list in descending order", "sort numbers from largest to smallest", "reverse sort a list"],
     'def sort_descending(numbers):\n    return sorted(numbers, reverse=True)\n\n\nprint(sort_descending([5, 2, 9, 1]))  # [9, 5, 2, 1]',
     'sort_descending([1, 3, 2]) == [3, 2, 1]'),
    (["implement bubble sort", "bubble sort a list", "write bubble sort"],
     'def bubble_sort(items):\n    items = list(items)\n    n = len(items)\n    for i in range(n):\n        for j in range(n - i - 1):\n            if items[j] > items[j + 1]:\n                items[j], items[j + 1] = items[j + 1], items[j]\n    return items\n\n\nprint(bubble_sort([4, 1, 3, 2]))  # [1, 2, 3, 4]',
     'bubble_sort([4, 1, 3, 2]) == [1, 2, 3, 4]'),
    (["implement binary search", "binary search in a sorted list", "find an item with binary search"],
     'def binary_search(items, target):\n    low, high = 0, len(items) - 1\n    while low <= high:\n        mid = (low + high) // 2\n        if items[mid] == target:\n            return mid\n        if items[mid] < target:\n            low = mid + 1\n        else:\n            high = mid - 1\n    return -1\n\n\nprint(binary_search([1, 3, 5, 7, 9], 7))  # 3',
     'binary_search([1, 3, 5, 7, 9], 7) == 3 and binary_search([1, 3], 4) == -1'),
    (["convert celsius to fahrenheit", "celsius to fahrenheit converter", "change celsius into fahrenheit"],
     'def celsius_to_fahrenheit(c):\n    return c * 9 / 5 + 32\n\n\nprint(celsius_to_fahrenheit(100))  # 212.0',
     'celsius_to_fahrenheit(100) == 212'),
    (["convert fahrenheit to celsius", "fahrenheit to celsius converter"],
     'def fahrenheit_to_celsius(f):\n    return (f - 32) * 5 / 9\n\n\nprint(fahrenheit_to_celsius(212))  # 100.0',
     'fahrenheit_to_celsius(212) == 100'),
    (["capitalize every word in a string", "make each word start with a capital letter", "title case a sentence"],
     'def capitalize_words(text):\n    return " ".join(word.capitalize() for word in text.split())\n\n\nprint(capitalize_words("hello there world"))  # Hello There World',
     'capitalize_words("hello there") == "Hello There"'),
    (["read a text file", "read the contents of a file", "open and read a file"],
     'def read_file(path):\n    with open(path, "r", encoding="utf-8") as f:\n        return f.read()\n\n\n# text = read_file("notes.txt")',
     'callable(read_file)'),
    (["write text to a file", "save a string to a file", "write to a file"],
     'def write_file(path, text):\n    with open(path, "w", encoding="utf-8") as f:\n        f.write(text)\n\n\n# write_file("notes.txt", "hello")',
     'callable(write_file)'),
    (["read a json file", "load json from a file", "read a JSON file and return its contents"],
     'import json\n\n\ndef read_json(path):\n    with open(path, "r", encoding="utf-8") as f:\n        return json.load(f)\n\n\n# data = read_json("data.json")',
     'callable(read_json)'),
    (["save data to a json file", "write a dictionary to a json file", "write json to a file"],
     'import json\n\n\ndef write_json(path, data):\n    with open(path, "w", encoding="utf-8") as f:\n        json.dump(data, f, indent=2)\n\n\n# write_json("data.json", {"name": "Buddo"})',
     'callable(write_json)'),
    (["count the lines in a file", "how many lines are in a file"],
     'def count_lines(path):\n    with open(path, "r", encoding="utf-8") as f:\n        return sum(1 for _ in f)\n\n\n# print(count_lines("notes.txt"))',
     'callable(count_lines)'),
    (["make a number guessing game", "simple guess the number game", "create a guessing game"],
     'import random\n\n\ndef guessing_game():\n    secret = random.randint(1, 100)\n    tries = 0\n    while True:\n        guess = int(input("Guess a number from 1 to 100: "))\n        tries += 1\n        if guess < secret:\n            print("Too low!")\n        elif guess > secret:\n            print("Too high!")\n        else:\n            print(f"You got it in {tries} tries!")\n            break\n\n\nguessing_game()',
     None),
    (["make a simple calculator", "calculator that adds subtracts multiplies and divides", "basic calculator"],
     'def calculate(a, op, b):\n    if op == "+":\n        return a + b\n    if op == "-":\n        return a - b\n    if op == "*":\n        return a * b\n    if op == "/":\n        if b == 0:\n            return "Cannot divide by zero"\n        return a / b\n    return "Unknown operator"\n\n\nprint(calculate(6, "*", 7))  # 42',
     'calculate(6, "*", 7) == 42 and calculate(1, "/", 0) == "Cannot divide by zero"'),
    (["print a multiplication table", "make a times table", "multiplication table for a number"],
     'def times_table(n, upto=10):\n    for i in range(1, upto + 1):\n        print(f"{n} x {i} = {n * i}")\n\n\ntimes_table(7)',
     'callable(times_table)'),
    (["fizzbuzz", "solve fizzbuzz", "print fizzbuzz from 1 to 100"],
     'def fizzbuzz(n):\n    for i in range(1, n + 1):\n        if i % 15 == 0:\n            print("FizzBuzz")\n        elif i % 3 == 0:\n            print("Fizz")\n        elif i % 5 == 0:\n            print("Buzz")\n        else:\n            print(i)\n\n\nfizzbuzz(100)',
     'callable(fizzbuzz)'),
    (["check if a year is a leap year", "leap year checker", "is this year a leap year"],
     'def is_leap_year(year):\n    return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)\n\n\nprint(is_leap_year(2024))  # True',
     'is_leap_year(2024) and not is_leap_year(1900) and is_leap_year(2000)'),
    (["find the greatest common divisor", "gcd of two numbers", "compute the gcd"],
     'def gcd(a, b):\n    while b:\n        a, b = b, a % b\n    return a\n\n\nprint(gcd(48, 18))  # 6',
     'gcd(48, 18) == 6'),
    (["find the least common multiple", "lcm of two numbers"],
     'def lcm(a, b):\n    x, y = a, b\n    while y:\n        x, y = y, x % y\n    return a * b // x\n\n\nprint(lcm(4, 6))  # 12',
     'lcm(4, 6) == 12'),
    (["sum the digits of a number", "add up the digits in a number"],
     'def digit_sum(n):\n    return sum(int(d) for d in str(abs(n)))\n\n\nprint(digit_sum(1234))  # 10',
     'digit_sum(1234) == 10'),
    (["reverse a number", "reverse the digits of an integer"],
     'def reverse_number(n):\n    sign = -1 if n < 0 else 1\n    return sign * int(str(abs(n))[::-1])\n\n\nprint(reverse_number(1234))  # 4321',
     'reverse_number(1234) == 4321 and reverse_number(-12) == -21'),
    (["check if two words are anagrams", "anagram checker", "test whether two strings are anagrams"],
     'def is_anagram(a, b):\n    return sorted(a.replace(" ", "").lower()) == sorted(b.replace(" ", "").lower())\n\n\nprint(is_anagram("listen", "silent"))  # True',
     'is_anagram("listen", "silent") and not is_anagram("abc", "abd")'),
    (["flatten a nested list", "turn a list of lists into one list", "flatten a list"],
     'def flatten(nested):\n    result = []\n    for item in nested:\n        if isinstance(item, list):\n            result.extend(flatten(item))\n        else:\n            result.append(item)\n    return result\n\n\nprint(flatten([1, [2, [3, 4]], 5]))  # [1, 2, 3, 4, 5]',
     'flatten([1, [2, [3, 4]], 5]) == [1, 2, 3, 4, 5]'),
    (["merge two dictionaries", "combine two dicts", "join two dictionaries"],
     'def merge_dicts(a, b):\n    merged = dict(a)\n    merged.update(b)\n    return merged\n\n\nprint(merge_dicts({"a": 1}, {"b": 2}))  # {\'a\': 1, \'b\': 2}',
     'merge_dicts({"a": 1}, {"b": 2, "a": 3}) == {"a": 3, "b": 2}'),
    (["square every number in a list", "get the squares of a list of numbers", "square all items in a list"],
     'def squares(numbers):\n    return [n * n for n in numbers]\n\n\nprint(squares([1, 2, 3, 4]))  # [1, 4, 9, 16]',
     'squares([1, 2, 3]) == [1, 4, 9]'),
    (["return the sum of the squares of a list of numbers", "sum of squares of a list"],
     'def sum_of_squares(numbers):\n    return sum(n * n for n in numbers)\n\n\nprint(sum_of_squares([1, 2, 3]))  # 14',
     'sum_of_squares([1, 2, 3]) == 14'),
    (["filter the even numbers from a list", "keep only even numbers in a list", "get the even numbers from a list"],
     'def even_numbers(numbers):\n    return [n for n in numbers if n % 2 == 0]\n\n\nprint(even_numbers([1, 2, 3, 4, 5, 6]))  # [2, 4, 6]',
     'even_numbers([1, 2, 3, 4]) == [2, 4]'),
    (["find the second largest number in a list", "get the second biggest number"],
     'def second_largest(numbers):\n    unique = sorted(set(numbers))\n    if len(unique) < 2:\n        return None\n    return unique[-2]\n\n\nprint(second_largest([4, 1, 9, 7]))  # 7',
     'second_largest([4, 1, 9, 7]) == 7 and second_largest([1]) is None'),
    (["generate a random password", "make a random password generator", "create a strong password"],
     'import random\nimport string\n\n\ndef make_password(length=12):\n    chars = string.ascii_letters + string.digits + string.punctuation\n    return "".join(random.choice(chars) for _ in range(length))\n\n\nprint(make_password())',
     'len(make_password(16)) == 16'),
    (["roll a dice", "simulate rolling a die", "random dice roll"],
     'import random\n\n\ndef roll_dice(sides=6):\n    return random.randint(1, sides)\n\n\nprint(roll_dice())',
     '1 <= roll_dice() <= 6'),
    (["count down from 10", "make a countdown timer", "countdown from a number"],
     'import time\n\n\ndef countdown(n):\n    while n > 0:\n        print(n)\n        time.sleep(1)\n        n -= 1\n    print("Done!")\n\n\ncountdown(10)',
     None),
    (["swap two variables", "swap the values of two variables"],
     'a = 5\nb = 10\na, b = b, a\nprint(a, b)  # 10 5',
     'a == 10 and b == 5'),
    (["convert a string to uppercase", "make text all caps"],
     'def shout(text):\n    return text.upper()\n\n\nprint(shout("hello"))  # HELLO',
     'shout("hi") == "HI"'),
    (["remove spaces from a string", "strip all whitespace from text"],
     'def remove_spaces(text):\n    return "".join(text.split())\n\n\nprint(remove_spaces("h e l l o"))  # hello',
     'remove_spaces(" a b  c ") == "abc"'),
    (["find the length of the longest word in a sentence", "get the longest word in a string"],
     'def longest_word(text):\n    words = text.split()\n    return max(words, key=len) if words else ""\n\n\nprint(longest_word("I love programming in Python"))  # programming',
     'longest_word("a abc ab") == "abc"'),
    (["convert a decimal number to binary", "turn a number into binary"],
     'def to_binary(n):\n    if n == 0:\n        return "0"\n    bits = ""\n    while n > 0:\n        bits = str(n % 2) + bits\n        n //= 2\n    return bits\n\n\nprint(to_binary(10))  # 1010',
     'to_binary(10) == "1010" and to_binary(0) == "0"'),
    (["make a class for a bank account", "create a bank account class with deposit and withdraw", "bank account program"],
     'class BankAccount:\n    def __init__(self, owner, balance=0):\n        self.owner = owner\n        self.balance = balance\n\n    def deposit(self, amount):\n        self.balance += amount\n        return self.balance\n\n    def withdraw(self, amount):\n        if amount > self.balance:\n            raise ValueError("Not enough money")\n        self.balance -= amount\n        return self.balance\n\n\naccount = BankAccount("Sam", 100)\naccount.deposit(50)\nprint(account.balance)  # 150',
     'account.balance == 150'),
    (["make a todo list program", "simple to-do list app", "create a todo list"],
     'todos = []\n\n\ndef add_task(task):\n    todos.append(task)\n\n\ndef show_tasks():\n    for i, task in enumerate(todos, start=1):\n        print(f"{i}. {task}")\n\n\nadd_task("Learn Python")\nadd_task("Build Buddo")\nshow_tasks()',
     'todos == ["Learn Python", "Build Buddo"]'),
    (["say hello world", "print hello world", "hello world program"],
     'print("Hello, world!")',
     'True'),
    (["ask for the user's name and greet them", "get input from the user and say hi"],
     'name = input("What is your name? ")\nprint(f"Nice to meet you, {name}!")',
     None),
    (["loop through a list and print each item", "print every item in a list", "iterate over a list"],
     'fruits = ["apple", "banana", "cherry"]\nfor fruit in fruits:\n    print(fruit)',
     'fruits == ["apple", "banana", "cherry"]'),
    (["make a dictionary and loop over it", "iterate through a dictionary"],
     'ages = {"Ana": 21, "Ben": 19, "Cy": 25}\nfor name, age in ages.items():\n    print(f"{name} is {age}")',
     'ages["Ben"] == 19'),
    (["calculate the area of a circle", "area of a circle from its radius"],
     'import math\n\n\ndef circle_area(radius):\n    return math.pi * radius ** 2\n\n\nprint(round(circle_area(3), 2))  # 28.27',
     'round(circle_area(1), 5) == round(3.14159265, 5)'),
    (["calculate compound interest", "compound interest calculator"],
     'def compound_interest(principal, rate, years):\n    return principal * (1 + rate) ** years\n\n\nprint(round(compound_interest(1000, 0.05, 10), 2))  # 1628.89',
     'round(compound_interest(1000, 0.05, 10), 2) == 1628.89'),
    (["calculate bmi", "body mass index calculator"],
     'def bmi(weight_kg, height_m):\n    return weight_kg / height_m ** 2\n\n\nprint(round(bmi(70, 1.75), 1))  # 22.9',
     'round(bmi(70, 1.75), 1) == 22.9'),
]

ASK_TEMPLATES = [
    "write a python function to {t}",
    "Write a Python function to {t}.",
    "write a function that can {t}",
    "make a python program to {t}",
    "how do I {t} in python?",
    "how to {t} in python",
    "python code to {t}",
    "can you {t} in python",
    "Can you write code to {t}?",
    "code to {t}",
    "{t}",
    "{T}",
    "{t} in python",
    "I need a function to {t}",
    "pls write python to {t}",
    "show me how to {t}",
]

# Things that aren't code requests, so Buddo learns to talk instead.
CHAT = [
    (["hi", "hello", "hey", "yo", "sup", "hiya", "hey buddo", "hi buddo", "hello there", "good morning", "wassup"],
     ["Hey! I'm Buddo. Ask me to write some Python, like \"reverse a string\" or \"check if a number is prime\".",
      "Hi! What Python code do you want me to write?",
      "Yo! Tell me what the code should do and I'll write it."]),
    (["how are you", "how are you doing", "hows it going", "how r u", "you good?", "whats up"],
     ["I'm good! Ready to write some Python. What do you need?",
      "Doing great. Give me a coding task!"]),
    (["who are you", "what are you", "what is your name", "whats your name", "who made you", "are you chatgpt", "are you an ai"],
     ["I'm Buddo, a tiny AI built completely from scratch. I run right on your phone and I'm best at writing short Python functions.",
      "I'm Buddo! A small language model trained from scratch on Python code. I'm not ChatGPT, I'm way smaller."]),
    (["what can you do", "help", "what do you do", "how do i use you", "what should i ask you"],
     ["I write Python. Describe what the code should do, for example: \"sum a list of numbers\", \"make a guessing game\" or \"read a json file\".",
      "Ask me for Python code! Try: \"check if a word is a palindrome\" or \"convert celsius to fahrenheit\"."]),
    (["thanks", "thank you", "thx", "ty", "nice", "cool", "awesome", "that works", "perfect", "great job"],
     ["No problem! Want another one?", "Anytime! What should we code next?", "Glad it helped!"]),
    (["bye", "goodbye", "see you", "later", "gn", "good night"],
     ["See you later! Come back when you need more code.", "Bye! Happy coding."]),
    (["what is python", "what's python", "explain python"],
     ["Python is a popular programming language that's easy to read. People use it for websites, games, data and AI. Want me to write you a first program?"]),
    (["tell me a joke", "say something funny", "make me laugh"],
     ["Why do programmers prefer dark mode? Because light attracts bugs.",
      "I would tell you a UDP joke, but you might not get it."]),
    (["what is 2+2", "what's the weather", "who is the president", "write me an essay", "what time is it", "tell me about history", "translate this to spanish", "what is the capital of france", "write a poem"],
     ["I'm a tiny model that only knows Python, so I can't answer that one. Ask me to write some code instead!",
      "That's outside what I know. I only write Python. Try something like \"make a calculator\"."]),
]


def build_examples(rng, task_reps=12, chat_reps=6):
    examples = []
    for asks, code, _ in TASKS:
        for _ in range(task_reps):
            t = rng.choice(asks)
            tmpl = rng.choice(ASK_TEMPLATES)
            examples.append((tmpl.format(t=t, T=t[0].upper() + t[1:]), code))
    for prompts, replies in CHAT:
        for p in prompts:
            for _ in range(chat_reps):
                q = rng.choice([p, p.capitalize(), p + "?", p + "!", p.upper() if len(p) < 6 else p])
                examples.append((q, rng.choice(replies)))
    rng.shuffle(examples)
    return examples


def check():
    failures = 0
    for asks, code, test in TASKS:
        if test is None:
            continue  # interactive (input/sleep): only syntax-check
        env = {}
        try:
            import contextlib
            import io

            with contextlib.redirect_stdout(io.StringIO()):
                exec(code, env)
            assert eval(test, env), test
        except Exception as e:
            failures += 1
            print(f"FAIL {asks[0]}: {e!r}")
    for asks, code, test in TASKS:
        if test is None:
            compile(code, asks[0], "exec")
    print(f"{len(TASKS)} tasks checked, {failures} failures")
    return failures == 0


def write_dataset(data_dir):
    import os

    import numpy as np

    from tokenizer import BOT, END, USER, Tokenizer

    tok = Tokenizer.load(os.path.join(data_dir, "tokenizer.json"))
    for split, seed, reps in (("train", 0, 40), ("val", 1, 2)):
        flat = []
        for q, a in build_examples(random.Random(seed), task_reps=reps, chat_reps=reps // 2 or 1):
            flat += [USER] + tok.encode(q) + [BOT] + tok.encode(a) + [END]
        np.array(flat, dtype=np.uint16).tofile(os.path.join(data_dir, f"tasks_{split}.bin"))
        print(f"tasks_{split}.bin: {len(flat) / 1e6:.2f}M tokens")


if __name__ == "__main__":
    if "--check" in sys.argv:
        sys.exit(0 if check() else 1)
    if len(sys.argv) > 1:
        write_dataset(sys.argv[1])  # python tasks.py DATA_DIR
    else:
        for q, a in build_examples(random.Random(0))[:5]:
            print("Q:", q, "\nA:", a[:80], "\n")
