// Number of stocks and initial data points
const NUM_STOCKS = 20;
const NUM_INITIAL_DATA_POINTS = 10;
const market = {
  overallVolatility: 0.1, // Overall market volatility
  industries: {
    tech: { volatility: 0.02, performance: 1 },
    healthcare: { volatility: 0.015, performance: 1 },
    finance: { volatility: 0.01, performance: 1 },
    crypto: { volatility: 0.6, performance: 1 },
  },
  stocks: [],
  marketIndexData: []
};

let playerStats = {
  startingCash: 5000,
  cashAvailable: 5000, // This will change based on trading activity
  portfolioValue: 0, // This will be calculated based on current positions
  margin:0,
  getTotalCapital: function() {
    return this.cashAvailable + this.portfolioValue;
  },
  getPurchasingPower: function() {
    return this.getTotalCapital() * 2; // Double the capital
},
};

// Transaction example: {ticker: 'AAPL', amount: 3, price: 150, type: 'buy'}
let transactions = [];

// Position example: {ticker: 'AAPL', amount: 3}
let positions = [];

let marketIndexChart; // Assuming this is globally accessible and stores the Chart.js instance for the market index

let chartzoom = 50;
// Initialize game data
let stocks = []; // Holds all stock data
let updateInterval = 333; // Update every 2000 milliseconds (2 seconds)
document.addEventListener('DOMContentLoaded', () => {
  initializeGame();
  updateUI();
  gameInterval=setInterval(mainGameLoop, updateInterval);

});

// Initialize shareFactor with a default value
let shareFactor = 1;
let isResetNext = true; // Flag to check if shareFactor needs to be reset on the next number input

// Function to update shareFactor based on input



let currentZoomIndex = 0; // Default zoom level index
const zoomLevels = [22, 50, 100, 220, 500, 1000, 2200]; // Defined zoom levels
function initializeGame() {
  const stockNames = ['IXN','KHZ','YEPW','GOLA','FIXN','PRT','GQ','NEXT','TNT','QLOT','VBUY','FTL','REPL'];
  const industries = Object.keys(market.industries);

  // Create stocks and assign to industries
  stockNames.forEach((name, index) => {
    const industry = industries[index % industries.length];
    const stock = {
      name,
      industry,
      volatility: Math.random() * 0.05 + 0.005, // Random volatility between 0.005 and 0.055
      pastData: [100] // Start price of 100 for simplicity
    };
    market.stocks.push(stock);
  }); updateStockPrices

  // Generate past data
  for (let i = 0; i < 50; i++) {
    updateStockPrices();
  }

  // Call these functions initially to set up the UI
  updateChartZoom();
  updateZoomLevelsUI();
  initializeTickerUI();
  initializeCapitalBreakdownChart();

}

function mainGameLoop() {
  updateStockPrices(); // Update stock prices for the simulation
  updateUI(); // Refresh the UI with the new stock data
  updateMarketIndex();
  updateTickersUI();
  updatePositionsUI();
  updateCapitalBreakdownChart();
  updatePortfolioValue();
}

// Start the game loop

// Implementing keybinds with keymaster.js
key('down', () => {
  // Move to the next ticker, looping back to the first if at the end
  selectedTicker = (selectedTicker + 1) % market.stocks.length;
  updateUI();
  return false; // Prevent default action
});

key('up', () => {
  // Move to the previous ticker, looping to the last if at the beginning
  selectedTicker = (selectedTicker - 1 + market.stocks.length) % market.stocks.length;
  updateUI();
  return false; // Prevent default action
});


// Update stock prices based on market and industry performance




function generateStockSymbols(numStocks, numDataPoints) {
  let generatedStocks = [];
  for (let i = 0; i < numStocks; i++) {
    // Generate a fake stock symbol
    let symbol = `STOCK${i}`;

    // Randomly assign volatility (for simplicity, let's use a number between 1 and 10)
    let volatility = Math.floor(Math.random() * 10) + 1;

    // Generate past data points for the stock
    let pastData = generatePastData(numDataPoints);

    generatedStocks.push({
      symbol: symbol,
      volatility: volatility,
      pastData: pastData
    });
  }
  return generatedStocks;
}
let capitalBreakdownChart; // This will hold the pie chart instance

function initializeCapitalBreakdownChart() {
    const ctx = document.getElementById('capitalBreakdownChart').getContext('2d');
    capitalBreakdownChart = new Chart(ctx, {
        type: 'pie',
        data: {
            labels: [], // Stock symbols will go here
            datasets: [{
                data: [], // The value of each stock position will go here
                backgroundColor: [], // Colors for each segment
                borderColor: 'rgba(255, 255, 255, 0.5)',
                borderWidth: 2
            }]
        },
        options: {
	    animation: false,
            responsive: false,
        
            plugins: {
                legend: {
                    display: true,
                    labels: {
                        color: 'rgb(255, 255, 255)', // Adjust color to fit your theme
                        font: {
                            size: 14 // Adjust font size as needed
                        }
                    }
                }
            }
        }
    });
}


function initializeTickerUI() { //initick
  const tickersContainer = document.getElementById('stockList');

  market.stocks.forEach(stock => {
    const stockDiv = document.createElement('div');
    stockDiv.setAttribute('data-ticker', stock.name);
    stockDiv.className = 'stock-item'; // Adding a class for styling and easier referencing
    stockDiv.id = `ticker-${stock.name}`;
    stockDiv.innerHTML = `<span class=symbol>${stock.name}</span> <span class=value>${stock.pastData[stock.pastData.length - 1]} </span> <span class=shares></span> <span class=holdings></span> <span class=ticker-profit-loss></span> `;
    const canvas = document.createElement('canvas');
    canvas.id = `graph-${stock.name}`;
    canvas.className = `mini-graph`;
    canvas.width = 70; // Example dimensions, adjust as needed
    canvas.height = 35;

    stockDiv.appendChild(canvas);
    tickersContainer.appendChild(stockDiv);

    // Initial blank chart setup
    new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        labels: [], datasets: [{
          data: [],
          pointStyle: false,
        }]
      },
      options: {
        animation: false,
        responsive: false,
        interactive: false,
        scales: {
          x: { display: false },
          y: { display: false }
        },
        plugins: {
          legend: { display: false }

        },
        elements: {
          line: {
            tension: 0 // Straight lines
          },
        },
        layout: {
          padding: 0 // Padding around the chart
        }
      }
    });
  });
}

function bindHotkeys() {
  // Bind keyboard events for trading actions
  document.addEventListener('keydown', (e) => {
    switch (e.key) {
      case 'B': // Example hotkey for buy
        // Call buy function
        break;
      case 'S': // Example hotkey for sell
        // Call sell function
        break;
      // Add more cases as needed
    }
  });
}

function buyStock(amount, tickerIndex) {
const stock = market.stocks[tickerIndex];
  const price = stock.pastData[stock.pastData.length - 1];
  const totalCost = price * amount;

  //if (playerStats.cashAvailable >= totalCost) {
    playerStats.cashAvailable -= totalCost; // Deduct the cost from cash available
    transactions.push({ ticker: stock.name, amount: amount, price: price, type: 'buy' });
    updatePositions(stock.name, amount, totalCost);
	
    updateTickersUI();
    updatePortfolioValue();
  //} else {
   // console.log('Not enough cash to complete this transaction.');
  //}
}

function sellStock(amount, tickerIndex) {
  const stock = market.stocks[tickerIndex];

  const price = stock.pastData[stock.pastData.length - 1];
  const totalValue = price * amount;

  transactions.push({ ticker: stock.name, amount: -amount, price: price, type: 'sell' });
  updatePositions(stock.name, -amount, -totalValue);
  updateTickersUI();
  playerStats.cashAvailable += totalValue; // Add the value to cash available
  updatePortfolioValue();


}


function exitPositions() {
  const selectedStock = market.stocks[selectedTicker];
  if (!selectedStock) {
    console.error('No stock selected.');
    return;
  }
 // Find the current position for the selected stock
  const position = positions.find(p => p.ticker === selectedStock.name);
  if (position) {
    if (position.amount > 0) {
      sellStock(position.amount, selectedTicker); // Sell all if holding positive shares
    } else if (position.amount < 0) {
      buyStock(Math.abs(position.amount), selectedTicker); // Cover all if shorting
    }
  }
  updatePositionsUI(); // Update the UI to reflect the position exit
  updateTickersUI();
}


  function buyAllIn() {
      const selectedStock = market.stocks[selectedTicker];
      if (!selectedStock) {
          console.error('Selected stock not found.');
          return;
      }

      // Get the price of the selected stock
      const stockPrice = selectedStock.pastData[selectedStock.pastData.length - 1];

      if (stockPrice <= 0) {
          console.error('Invalid stock price.');
          return;
      }

      // Calculate the maximum number of shares that can be bought
      const maxShares = Math.floor(playerStats.cashAvailable / stockPrice);

      if (maxShares > 0) {
          buyStock(maxShares, selectedTicker); // Assumes you have a function buyStock(amount, tickerIndex) defined
          console.log(`Bought ${maxShares} shares of ${selectedStock.name}`);
      } else {
          console.error('Not enough cash to buy any shares.');
      }
  }

  
 

function updateStockPrices() {
  let totalMarketValue = 0;
  let stocksCounted = 0;
  market.stocks.forEach(stock => {
    const industryPerformance = market.industries[stock.industry].performance;
    // Introduce additional randomness
    const randomFactor = (Math.random() - 0.5) * 2;
    const change = randomFactor * stock.volatility;

    const newPrice = stock.pastData[stock.pastData.length - 1] * (1 + change + (industryPerformance - 1));
    stock.pastData.push(Math.max(newPrice, 1)); // Prevent negative prices
    totalMarketValue += Math.max(newPrice, 1);
    stocksCounted++;
  });
  if (stocksCounted > 0) {
    const averageMarketPrice = totalMarketValue / stocksCounted;
    market.marketIndexData.push(averageMarketPrice);
  }
}

function updatePositions(ticker, amount, totalCost) {
  const position = positions.find(p => p.ticker === ticker);
  if (position) {
    position.amount += amount;
	position.totalCost = (position.totalCost || 0) + totalCost;
    if (position.amount === 0) {
      // Remove the position if it's neutralized
      positions = positions.filter(p => p.ticker !== ticker);
    }
  } else {
    positions.push({ ticker: ticker, amount: amount, totalCost: totalCost });
	
  }
  updateMessagePos();
  updatePositionsUI();
}
function updateMessagePos(){
	const selectedStock = market.stocks[selectedTicker];
	const position = positions.find(f => f.ticker === selectedStock.name);
	if(position){
		if(position.amount>0){
			document.getElementById('message-buy').innerText='Buy';
			document.getElementById('message-sell').innerText='Sell';
			document.getElementById('controls-buy').innerText='Buy';
			document.getElementById('controls-sell').innerText='Sell';
		}else if(position.amount<0){
			document.getElementById('message-buy').innerText='Cover';
			document.getElementById('message-sell').innerText='Short';
			document.getElementById('controls-buy').innerText='Cover';
			document.getElementById('controls-sell').innerText='Short';
		}else{
			document.getElementById('message-buy').innerText='Buy';
			document.getElementById('message-sell').innerText='Short';
		}
	}else{
		document.getElementById('message-buy').innerText='Buy';
			document.getElementById('message-sell').innerText='Short';
			document.getElementById('controls-buy').innerText='Buy';
			document.getElementById('controls-sell').innerText='Short';
	}
	updateMessageTicker();
	
}
function updateMessageTicker(){
	const selectedStock = market.stocks[selectedTicker];
	const position = positions.find(f => f.ticker === selectedStock.name);
	document.getElementById('message-price').innerText=(Math.round(selectedStock.pastData[selectedStock.pastData.length-1]*100*shareFactor)/100);
}
function updateMessageSelectionChange(){
	const selectedStock = market.stocks[selectedTicker];
	const position = positions.find(f => f.ticker === selectedStock.name);
	document.getElementById('message-symbol').innerText=selectedStock.name;
	updateMessagePos();
	updateMessageTicker();
}

function gameOver(){
	  updatePlayerStatsUI();
		document.getElementById('cashAvailable').textContent = `Margin Call!`;
	  document.getElementById('portfolioValue').textContent = `Margin Call!`;
	  document.getElementById('totalCapital').textContent = `Total Capital: $${playerStats.getTotalCapital().toFixed(2)}`;
			// Game ends, clear the game interval
			clearInterval(gameInterval);

			// Optionally, update the UI or notify the player that the game has ended
			console.error("Game Over: Total capital has dropped below zero.");
}
function updatePortfolioValue() {
    playerStats.portfolioValue = positions.reduce((acc, position) => {
        const stock = market.stocks.find(s => s.name === position.ticker);
        const latestPrice = stock.pastData[stock.pastData.length - 1];
        return acc + (latestPrice * position.amount);
    }, 0);

    // Calculate total capital (portfolio value + cash available)
    const totalCapital = playerStats.portfolioValue + playerStats.cashAvailable;

    // Check if total capital drops below zero
    if (totalCapital < 0) {
		gameOver();
		
        // Here you can also invoke any function to handle game over state, like showing a message to the user.
    } else {
        // Optionally, update the UI to reflect the new portfolio value and cash available
        updatePlayerStatsUI();
    }
}

function updateCapitalBreakdownChart() {
    if (!capitalBreakdownChart) {
        console.error('Capital Breakdown Chart is not initialized.');
        return;
    }

    const labels = [];
    const data = [];
    const backgroundColors = [];

    // Update chart data for each stock position
    positions.forEach((position) => {
        const stock = market.stocks.find(s => s.name === position.ticker);
        if (stock) {
            const latestPrice = stock.pastData[stock.pastData.length - 1];
            const positionValue = latestPrice * position.amount;

            labels.push(position.ticker);
            data.push(positionValue);
            backgroundColors.push('#00'); // Set background color for equities
        }
    });

    // Optionally, include cash as part of the capital breakdown
    labels.push('Cash');
    data.push(playerStats.cashAvailable);
    backgroundColors.push('rgba(0, 0, 0, 0)'); // Transparent color for cash

    capitalBreakdownChart.data.labels = labels;
    capitalBreakdownChart.data.datasets.forEach((dataset) => {
        dataset.data = data;
        dataset.backgroundColor = backgroundColors;
    });

    capitalBreakdownChart.update();
}


function updateTickersUI() { //uptick
  market.stocks.forEach(stock => {
    const dataPoints = stock.pastData.slice(-chartzoom);
    const gainLoss = dataPoints[dataPoints.length - 1] - dataPoints[0];
    const trendLineColor = gainLoss > 0 ? '#0f0' : gainLoss < 0 ? '#f00' : 'cyan';
    const div = document.getElementById(`ticker-${stock.name}`);
    div.querySelector('.value').textContent = Math.round(stock.pastData[stock.pastData.length - 1] * 100) / 100;
    const latestPrice = stock.pastData[stock.pastData.length - 1];
    if(positions.length!=0){
       const position = positions.find(p => p.ticker === stock.name);
       if(position){
          const investmentValue = latestPrice * position.amount;
	  console.log(investmentValue);
          div.querySelector('.holdings').textContent = Math.round(investmentValue * 100) / 100;
		  div.querySelector('.shares').textContent = position.amount;
		  const totalCost = position.totalCost;
			const profitLoss = investmentValue - totalCost;
			const profitLossIndicator = profitLoss >= 0 ? `<span class=profit>▲$${Math.abs(profitLoss).toFixed(2)}</span>` :` <span class=loss>▼$${Math.abs(profitLoss).toFixed(2)}</span> `;
		    div.querySelector('.ticker-profit-loss').innerHTML = profitLossIndicator;

       }else{
       div.querySelector('.holdings').textContent = '';
	   div.querySelector('.shares').textContent = '';
	   div.querySelector('.ticker-profit-loss').textContent = '';
	   
       }
    }else{
       div.querySelector('.holdings').textContent = '';
	   div.querySelector('.shares').textContent = '';
	   div.querySelector('.ticker-profit-loss').textContent = '';
    }
    const canvas = document.getElementById(`graph-${stock.name}`);
    if (canvas) {
      const chart = Chart.getChart(canvas.id); // Retrieve the existing chart instance
      if (chart) {
        chart.data.labels = dataPoints.map((_, index) => index + 1);
        chart.data.datasets.forEach((dataset) => {
          dataset.data = dataPoints;
          dataset.borderColor = trendLineColor;
        });
        chart.update();
      }
    }

    // Optionally, update the gain/loss indicator text here as well
  });
  const stockListDivs = document.getElementById('stockList').querySelectorAll('div[data-ticker]');
  stockListDivs.forEach(div => {
    if (div.getAttribute('data-ticker') === market.stocks[selectedTicker].name) {
      div.style.border = '2px solid white';
    } else {
      div.style.border = 'none'; // Remove border from non-selected tickers
    }
  });
  updateMessageTicker();
}


let selectedTicker = 0; // Default selected ticker index
let stockChart; // This will hold the Chart.js chart instance

function updateChartZoom() {
  const selectedZoomLevel = zoomLevels[currentZoomIndex];
  updateChartDisplay(selectedZoomLevel); // Update the chart to show the selected number of data points
  updateZoomLevelsUI(); // Update the UI to reflect the current zoom level
}

function zoomIn() {
  if (currentZoomIndex < zoomLevels.length - 1) {
    currentZoomIndex++;
    updateChartZoom();
  }
}

function zoomOut() {
  if (currentZoomIndex > 0) {
    currentZoomIndex--;
    updateChartZoom();
  }
}


function updateZoomLevelsUI() {
  const zoomLevelsContainer = document.getElementById('zoomLevels');
  zoomLevelsContainer.innerHTML = ''; // Clear existing zoom levels

  zoomLevels.forEach((level, index) => {
    const zoomLevelDiv = document.createElement('div');
    zoomLevelDiv.textContent = level;
    if (index === currentZoomIndex) {
      zoomLevelDiv.style.color = 'green'; // Highlight the selected zoom level
    }
    zoomLevelsContainer.appendChild(zoomLevelDiv);
  });
}


function updatePositionsUI() {
  const positionsContainer = document.getElementById('playerPositions');
  positionsContainer.innerHTML = ''; // Clear the container for updated information

  positions.forEach(position => {
    // Find the corresponding stock for the current position
    const stock = market.stocks.find(s => s.name === position.ticker);
    const latestPrice = stock.pastData[stock.pastData.length - 1];

    // Calculate the total cost and the total value of the position
    const totalCost = transactions
      .filter(t => t.ticker === position.ticker)
      .reduce((acc, curr) => acc + (curr.price * curr.amount), 0);
    const investmentValue = latestPrice * position.amount;
    const profitLoss = investmentValue - totalCost;
    const profitLossIndicator = profitLoss >= 0 ? `▲$${Math.abs(profitLoss).toFixed(2)}` : `▼$${Math.abs(profitLoss).toFixed(2)}`;

    // Create the display string for the position
    const positionString = `${position.ticker} ${position.amount} shares, $${investmentValue.toFixed(2)} (${profitLossIndicator} total P/L)`;

    // Append this position's information to the positions container
    positionsContainer.innerHTML += `<div data-symbol=${stock.name}>${positionString}</div>`;
  });


  // Highlight the selected ticker in the player positions list
  const playerPositionsDivs = document.getElementById('playerPositions').querySelectorAll('div[data-symbol]');
  playerPositionsDivs.forEach(div => {
    if (div.getAttribute('data-symbol') === market.stocks[selectedTicker].name) {
      div.style.border = '2px solid white';
    } else {
      div.style.border = 'none'; // Remove border from non-selected positions
    }
  });
}


function updatePlayerStatsUI() {
  document.getElementById('cashAvailable').textContent = `Cash Available: $${playerStats.cashAvailable.toFixed(2)}`;
  document.getElementById('portfolioValue').textContent = `Portfolio Value: $${playerStats.portfolioValue.toFixed(2)}`;
  document.getElementById('totalCapital').textContent = `Total Capital: $${playerStats.getTotalCapital().toFixed(2)}`;
}

function updateChartDisplay(selectedZoomLevel) {
  chartzoom = selectedZoomLevel;
}

function updateUI() {
  // Access the selected stock using the selectedTicker index
  const selectedStock = market.stocks[selectedTicker];
  if (!selectedStock) {
    console.error('Selected stock not found.');
    return;
  }

  // Extract the last 50 data points for the selected stock
  const dataPoints = selectedStock.pastData.slice(-chartzoom);
  const labels = dataPoints.map((_, index) => `Point ${index + 1}`); // Generate labels for the data points
  Chart.defaults.color = '#fff';
  // Chart configuration
  const config = {
    type: 'line', // Line chart to represent stock price changes over time
    data: {
      labels: labels, // Assigning the generated labels to the chart
      datasets: [{
        label: `${selectedStock.name} Price`, // Displaying the ticker name and "Price

        data: dataPoints, // The last 50 data points of the selected stock
        fill: false,
        borderColor: 'rgb(20, 255, 20)', // Line color
        tension: 0, // Slightly smooth line
		pointStyle: false,
      }]
    },
    options: {
      animation: false,
      responsive: true,
      plugins: {
        legend: {
          display: true // Ensure the legend is displayed
        }
      },
      scales: {
        y: {
          beginAtZero: false,
          title: {
            display: true,
            text: 'Price' // Y-axis title
          }
        },
        x: {
          title: {
            display: true,
            text: 'Last ' + chartzoom + ' Data Points' // X-axis title
          }
        }
      }
    }
  };


  // Check if a chart instance already exists
  if (stockChart) {
    // If it exists, update the chart with new data
    stockChart.data = config.data;
    stockChart.options = config.options;
    stockChart.update();
  } else {
    // If it doesn't exist, create a new chart instance
    const ctx = document.getElementById('stockChart').getContext('2d');
    stockChart = new Chart(ctx, config);
  }


  // Highlight the selected ticker in the stock list
  const stockListDivs = document.getElementById('stockList').querySelectorAll('div[data-ticker]');
  stockListDivs.forEach(div => {
    if (div.getAttribute('data-ticker') === market.stocks[selectedTicker].name) {
      div.style.border = '2px solid white';
    } else {
      div.style.border = 'none'; // Remove border from non-selected tickers
    }
  });

  // Highlight the selected ticker in the player positions list
  const playerPositionsDivs = document.getElementById('playerPositions').querySelectorAll('div[data-symbol]');
  playerPositionsDivs.forEach(div => {
    if (div.getAttribute('data-symbol') === market.stocks[selectedTicker].name) {
      div.style.border = '2px solid white';
    } else {
      div.style.border = 'none'; // Remove border from non-selected positions
    }
  });
}

function updateMarketIndex() {
  // Extract data for the market index chart, using the latest 'chartzoom' data points
  const dataPoints = market.marketIndexData.slice(-chartzoom);
  const labels = dataPoints.map((_, index) => `Point ${index + 1}`);

  // Chart configuration for market index
  const config = {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'Market Index',
        data: dataPoints,
        fill: false,
        borderColor: 'rgb(255, 99, 132)', // Choose a different color for distinction
        tension: 0.5,
		pointStyle: false,
      }]
    },
    options: {
      animation: false,
      responsive: true,
      plugins: {
        legend: {
          display: true
        }
      },
      scales: {
        y: {
          beginAtZero: false,
          title: {
            display: true,
            text: 'Average Price'
          }
        },
        x: {
          title: {
            display: true,
            text: `Last ${chartzoom} Data Points`
          }
        }
      }
    }
  };

  // Check if a chart instance for market index already exists
  if (marketIndexChart) {
    // If it exists, update the chart with new data
    marketIndexChart.data = config.data;
    marketIndexChart.options = config.options;
    marketIndexChart.update();
  } else {
    // If it doesn't exist, create a new chart instance
    const ctx = document.getElementById('marketIndexGraph').getContext('2d');
    marketIndexChart = new Chart(ctx, config);
  }
}

document.addEventListener('keydown', function(event) {
    // Check if the key pressed is a number from the numeric keypad
    if (event.key >= 0 && event.key <= 9 && event.location === KeyboardEvent.DOM_KEY_LOCATION_NUMPAD) {
        if (isResetNext) {
            shareFactor = 0;
            isResetNext = false;
        }
        // Update shareFactor by appending the new digit
        shareFactor = shareFactor * 10 + parseInt(event.key);
        console.log(`shareFactor is now: ${shareFactor}`);
		var sharem=" shares";
		if(shareFactor==1){
			sharem=" share";
		}
		document.getElementById('message-sharefactor').innerText=shareFactor + sharem;
    }

    // Check if the pressed key is Num Enter
    if (event.key === 'Enter' && event.location === KeyboardEvent.DOM_KEY_LOCATION_NUMPAD) {
        isResetNext = true; // Next number input will reset shareFactor
        console.log('Next input will reset shareFactor.');
    }
});

// Bind numpad number keys (0-9)


function calculateMarketPerformance() {
  // Simplified calculation of market performance
  // This should be replaced with your logic to calculate the overall market performance based on your requirements
  const performance = market.stocks[0].pastData.map((_, index) =>
    market.stocks.reduce((acc, stock) => acc + stock.pastData[index], 0) / market.stocks.length
  );
  return performance;
}


key('down', () => {
  // Move to the next ticker, looping back to the first if at the end
  selectedTicker = (selectedTicker) % market.stocks.length;
  updateUI();
  updateMessageSelectionChange();
  return false; // Prevent default action
});

key('up', () => {
  // Move to the previous ticker, looping to the last if at the beginning
  selectedTicker = (selectedTicker + market.stocks.length) % market.stocks.length;
  updateUI();
  updateMessageSelectionChange();
  return false; // Prevent default action
});
document.addEventListener('keydown', function(event) {
    // Check if Enter key is pressed and ensure it's not the numpad Enter
    if (event.key === 'Enter' && event.location !== KeyboardEvent.DOM_KEY_LOCATION_NUMPAD) {
        // Your buyStock function logic here. Assuming buyStock takes the amount and tickerIndex.
        // Example call, adjust parameters according to your function definition
        buyStock(shareFactor, selectedTicker); // Buys 1 share of the selected stock
    }
});


document.addEventListener('keydown', function(event) {
    // Check if Enter key is pressed and ensure it's not the numpad Enter
    if (event.key === 'Backspace' && event.location !== KeyboardEvent.DOM_KEY_LOCATION_NUMPAD) {
        // Your buyStock function logic here. Assuming buyStock takes the amount and tickerIndex.
        // Example call, adjust parameters according to your function definition
        sellStock(shareFactor, selectedTicker); // Buys 1 share of the selected stock
    }
});


key('9', () => {
  zoomOut();
  return false; // Prevent the default action
});

// Bind the 'zoom out' action to the minus key
key('0', () => {
  zoomIn();
  return false; // Prevent the default action
});

key('\\', exitPositions);
key('l', function(){ buyAllIn() });


// Bind numpad enter to reset shareFactor on next input
key('num_enter', () => {
    isResetNext = true;
    console.log(`Next input will reset shareFactor.`);
});
function displayMarketSummary() {
  console.log('Market Summary');
  console.log('---------------');
  console.log(`Overall Market Volatility: ${market.overallVolatility.toFixed(4)}`);
  console.log('Industries Performance:');
  Object.entries(market.industries).forEach(([name, { volatility, performance }]) => {
    console.log(`- ${name}: Volatility=${volatility.toFixed(4)}, Performance=${performance.toFixed(4)}`);
  });
  console.log('Stocks Latest Prices:');
  market.stocks.forEach(stock => {
    const latestPrice = stock.pastData[stock.pastData.length - 1];
    console.log(`- ${stock.name} (${stock.industry}): Latest Price=${latestPrice.toFixed(2)}`);
  });
  console.log('---------------\n');
}


