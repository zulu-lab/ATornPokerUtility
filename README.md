# Player Classification – Zulu Poker Tracker

Player classification is a core component of the system.  
It does not simply assign labels, but provides a structured, real-time interpretation of player behavior to support decision-making.

The model is based on three primary variables:

- VPIP (Voluntarily Put Money In Pot)  
  Percentage of hands in which a player voluntarily invests chips pre-flop.

- PFR (Pre-Flop Raise)  
  Percentage of hands in which a player raises pre-flop.

- Hands (Sample Size)  
  Number of observed hands, used to evaluate statistical reliability.

Player types emerge from the relationship between VPIP and PFR, not from isolated values.

---

## Core Logic

Two players with the same VPIP can behave very differently:

- High VPIP + High PFR → aggressive player  
- High VPIP + Low PFR → passive player  

Similarly:

- Low VPIP → selective hand range  
- High PFR → initiative-driven play  

Classification is therefore a way to interpret intent and decision structure, not just frequency.

---

## Player Types

### NEW (Insufficient Data)

Condition:
- Too few observed hands to produce reliable metrics

Profile:
No stable pattern can be identified yet.

Operational Note:
- Avoid relying on HUD data
- Treat as unknown player

---

### NIT (Ultra Tight)

Typical Values:
- Low VPIP  
- Low PFR  

Profile:
Extremely selective player. Participates only with strong hands and rarely takes initiative.

Characteristics:
- Very narrow range  
- Low variance  
- Risk-averse behavior  

Strategic Interpretation:
When involved in a hand, this player is often strong.

---

### TAG (Tight Aggressive)

Typical Values:
- Medium-low VPIP  
- Medium PFR  

Profile:
Structured and disciplined player. Selects hands carefully but plays them actively.

Characteristics:
- Controlled range  
- Consistent aggression  
- Rational decision-making  

Strategic Interpretation:
Balanced profile. Difficult to exploit without deeper reads.

---

### LAG (Loose Aggressive)

Typical Values:
- High VPIP  
- High PFR  

Profile:
Highly active and aggressive player. Enters many pots and applies constant pressure.

Characteristics:
- Wide range  
- Frequent initiative  
- High variance  

Strategic Interpretation:
Can force mistakes but is exposed to volatility.

---

### CALL (Loose Passive)

Typical Values:
- High VPIP  
- Low PFR  

Profile:
Player who frequently enters pots but rarely raises.

Characteristics:
- Call-heavy behavior  
- Low aggression  
- Reactive decisions  

Strategic Interpretation:
Follows rather than leads. Tends to reveal information through passivity.

---

### FISH (Inefficient Player)

Typical Values:
- Very high VPIP  
- Low or inconsistent PFR  

Profile:
Unstructured player with no consistent strategic logic.

Characteristics:
- Extremely wide range  
- Irregular decisions  
- Frequent mistakes  

Strategic Interpretation:
High likelihood of suboptimal decisions over time.

---

## Metric Interpretation

### VPIP

Measures how often a player chooses to enter a pot.

- Low → selective  
- High → frequently involved  

---

### PFR

Measures willingness to take initiative.

- Low → passive  
- High → aggressive  

---

### VPIP vs PFR Relationship

The interaction between these two metrics defines player style:

- VPIP ≈ PFR → consistent aggression  
- VPIP >> PFR → passive behavior  
- Low VPIP + Low PFR → extreme selectivity  

---

## Model Limitations

- Data is initially local and incremental  
- Classification improves as more hands are observed  
- Currently does not account for:
  - table position  
  - stack size  
  - table dynamics  

---

## Objective

The classification system is not meant to provide fixed labels, but to serve as:

- a real-time interpretation tool  
- a decision-support layer  
- a foundation for advanced server-side analytics  

---

This approach transforms sequences of actions into readable behavioral patterns, reducing uncertainty and improving decision quality.
