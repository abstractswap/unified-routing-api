import { DutchLimitOrderBuilder, DutchLimitOrderInfoJSON, encodeExclusiveFillerData } from '@uniswap/gouda-sdk';
import { TradeType } from '@uniswap/sdk-core';
import { BigNumber, ethers } from 'ethers';

import { v4 as uuidv4 } from 'uuid';
import { Quote, QuoteJSON } from '.';
import { DutchLimitRequest, RoutingType } from '..';
import { HUNDRED_PERCENT } from '../../constants';
import { currentTimestampInSeconds } from '../../util/time';
import { ClassicQuote } from './ClassicQuote';
import { LogJSON } from './index';

export type DutchLimitQuoteJSON = {
  chainId: number;
  requestId: string;
  quoteId: string;
  tokenIn: string;
  amountIn: string;
  tokenOut: string;
  amountOut: string;
  offerer: string;
  filler?: string;
};

export class DutchLimitQuote implements Quote {
  public routingType: RoutingType.DUTCH_LIMIT = RoutingType.DUTCH_LIMIT;
  // TODO: replace with better values
  // public static improvementExactIn = BigNumber.from(10100);
  // public static improvementExactOut = BigNumber.from(9900);
  public static improvementExactIn = BigNumber.from(10010);
  public static improvementExactOut = BigNumber.from(9990);

  public static fromResponseBody(
    request: DutchLimitRequest,
    body: DutchLimitQuoteJSON,
    nonce?: string
  ): DutchLimitQuote {
    return new DutchLimitQuote(
      currentTimestampInSeconds(),
      request,
      body.chainId,
      body.requestId,
      body.quoteId,
      body.tokenIn,
      BigNumber.from(body.amountIn),
      body.tokenOut,
      BigNumber.from(body.amountOut),
      body.offerer,
      body.filler,
      nonce
    );
  }

  constructor(
    public readonly createdAt: string,
    public readonly request: DutchLimitRequest,
    public readonly chainId: number,
    public readonly requestId: string,
    public readonly quoteId: string,
    public readonly tokenIn: string,
    public readonly amountIn: BigNumber,
    public readonly tokenOut: string,
    public readonly amountOut: BigNumber,
    public readonly offerer: string,
    public readonly filler?: string,
    public readonly nonce?: string
  ) {
    this.createdAt = createdAt || currentTimestampInSeconds();
  }

  public static fromClassicQuote(request: DutchLimitRequest, quote: ClassicQuote): DutchLimitQuote {
    if (request.info.type === TradeType.EXACT_INPUT) {
      return new DutchLimitQuote(
        quote.createdAt,
        request,
        request.info.tokenInChainId,
        request.info.requestId,
        uuidv4(), // synthetic quote doesn't receive a quoteId from RFQ api, so generate one
        request.info.tokenIn,
        request.info.amount, // fixed amountIn
        quote.request.info.tokenOut,
        quote.amountOutGasAdjusted.mul(DutchLimitQuote.improvementExactIn).div(HUNDRED_PERCENT),
        request.config.offerer,
        '', // synthetic quote has no filler
        undefined // synthetic quote has no nonce
      );
    } else {
      return new DutchLimitQuote(
        quote.createdAt,
        request,
        request.info.tokenInChainId,
        request.info.requestId,
        uuidv4(), // synthetic quote doesn't receive a quoteId from RFQ api, so generate one
        request.info.tokenIn,
        quote.amountInGasAdjusted.mul(DutchLimitQuote.improvementExactOut).div(HUNDRED_PERCENT),
        quote.request.info.tokenOut,
        request.info.amount, // fixed amountOut
        request.config.offerer,
        '', // synthetic quote has no filler
        undefined // synthetic quote has no nonce
      );
    }
  }

  public toJSON(): QuoteJSON {
    return {
      ...this.toOrder(),
      quoteId: this.quoteId,
    };
  }

  public toOrder(): DutchLimitOrderInfoJSON {
    const orderBuilder = new DutchLimitOrderBuilder(this.chainId);
    const startTime = Math.floor(Date.now() / 1000);
    const nonce = this.nonce ?? this.generateRandomNonce();
    const decayStartTime = startTime + this.request.config.exclusivePeriodSecs;

    const builder = orderBuilder
      .startTime(decayStartTime)
      .endTime(decayStartTime + this.request.config.auctionPeriodSecs)
      .deadline(decayStartTime + this.request.config.auctionPeriodSecs)
      .offerer(this.request.config.offerer)
      .nonce(BigNumber.from(nonce))
      .input({
        token: this.tokenIn,
        startAmount: this.amountIn,
        endAmount:
          this.request.info.type === TradeType.EXACT_INPUT ? this.amountIn : this.calculateEndAmountFromSlippage(),
      })
      .output({
        token: this.tokenOut,
        startAmount: this.amountOut,
        endAmount:
          this.request.info.type === TradeType.EXACT_INPUT ? this.calculateEndAmountFromSlippage() : this.amountOut,
        recipient: this.request.config.offerer,
        isFeeOutput: false,
      });

    if (this.filler) {
      builder.validation(encodeExclusiveFillerData(this.filler, decayStartTime, this.chainId));
    }

    const order = builder.build();

    return order.toJSON();
  }

  public toLog(): LogJSON {
    return {
      tokenInChainId: this.chainId,
      tokenOutChainId: this.chainId,
      requestId: this.requestId,
      quoteId: this.quoteId,
      tokenIn: this.tokenIn,
      tokenOut: this.tokenOut,
      amountIn: this.amountIn.toString(),
      amountOut: this.amountOut.toString(),
      amountInGasAdjusted: this.amountIn.toString(),
      amountOutGasAdjusted: this.amountOut.toString(),
      offerer: this.offerer,
      filler: this.filler,
      routing: RoutingType[this.routingType],
      createdAt: this.createdAt,
    };
  }

  private calculateEndAmountFromSlippage(): BigNumber {
    if (this.request.info.type === TradeType.EXACT_INPUT) {
      return this.amountOut
        .mul(HUNDRED_PERCENT.sub(BigNumber.from(this.request.info.slippageTolerance)))
        .div(HUNDRED_PERCENT);
    } else {
      return this.amountIn
        .mul(HUNDRED_PERCENT.add(BigNumber.from(this.request.info.slippageTolerance)))
        .div(HUNDRED_PERCENT);
    }
  }

  private generateRandomNonce(): string {
    return ethers.BigNumber.from(ethers.utils.randomBytes(31)).shl(8).toString();
  }
}
